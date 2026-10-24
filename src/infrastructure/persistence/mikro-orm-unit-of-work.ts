import { IsolationLevel } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type {
  ReadRepositories,
  Repositories,
  TransactionKind,
  UnitOfWorkPort,
} from '@application/ports/unit-of-work.port';
import type { AppConfig } from '@infrastructure/config/env.schema';
import type { OrmInstances } from './orm-instances';
import { pgErrorClassifier } from './pg-error-classifier';
import { createRepositories } from './repositories.factory';

export type UnitOfWorkTimeouts = Pick<
  AppConfig,
  'DB_LOCK_TIMEOUT_MS' | 'DB_STATEMENT_TIMEOUT_MS' | 'DB_TRANSACTION_TIMEOUT_MS'
>;

export type RepositoriesFactory = (em: EntityManager) => Repositories;

interface TransactionPlan {
  readonly orm: MikroORM;
  readonly isolationLevel: IsolationLevel;
  readonly statements: readonly string[];
}

const SHORT_STATEMENTS: readonly string[] = [
  "SET LOCAL lock_timeout = '1s'",
  "SET LOCAL statement_timeout = '2s'",
];

const RECONCILIATION_STATEMENTS: readonly string[] = [
  'SET TRANSACTION READ ONLY',
  "SET LOCAL statement_timeout = '60s'",
];

const milliseconds = (value: number): string => `'${String(value)}ms'`;

const writeStatements = (timeouts: UnitOfWorkTimeouts): readonly string[] => [
  `SET LOCAL lock_timeout = ${milliseconds(timeouts.DB_LOCK_TIMEOUT_MS)}`,
  `SET LOCAL statement_timeout = ${milliseconds(timeouts.DB_STATEMENT_TIMEOUT_MS)}`,
  `SET LOCAL transaction_timeout = ${milliseconds(timeouts.DB_TRANSACTION_TIMEOUT_MS)}`,
];

export class MikroOrmUnitOfWork implements UnitOfWorkPort {
  private readonly plans: Readonly<Record<TransactionKind, TransactionPlan>>;

  constructor(
    private readonly instances: OrmInstances,
    timeouts: UnitOfWorkTimeouts,
    private readonly repositoriesFactory: RepositoriesFactory = createRepositories,
  ) {
    this.plans = {
      write: {
        orm: instances.main,
        isolationLevel: IsolationLevel.READ_COMMITTED,
        statements: writeStatements(timeouts),
      },
      short: {
        orm: instances.main,
        isolationLevel: IsolationLevel.READ_COMMITTED,
        statements: SHORT_STATEMENTS,
      },
      reconciliation: {
        orm: instances.reconciliation,
        isolationLevel: IsolationLevel.REPEATABLE_READ,
        statements: RECONCILIATION_STATEMENTS,
      },
    };
  }

  async run<T>(kind: TransactionKind, work: (repos: Repositories) => Promise<T>): Promise<T> {
    const plan = this.plans[kind];
    const em = plan.orm.em.fork({ clear: true });
    try {
      return await em.transactional(
        async (transactionEm) => {
          for (const statement of plan.statements) {
            await transactionEm.execute(statement);
          }
          return work(this.repositoriesFactory(transactionEm));
        },
        { isolationLevel: plan.isolationLevel },
      );
    } catch (error) {
      throw pgErrorClassifier.wrap(error);
    }
  }

  async read<T>(work: (repos: ReadRepositories) => Promise<T>): Promise<T> {
    const em = this.instances.main.em.fork({ clear: true });
    const { wallets, transactions, ledger, idempotency, inbox } = this.repositoriesFactory(em);
    try {
      return await work({ wallets, transactions, ledger, idempotency, inbox });
    } catch (error) {
      throw pgErrorClassifier.wrap(error);
    }
  }
}
