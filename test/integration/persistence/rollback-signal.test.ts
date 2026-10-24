import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Client } from 'pg';
import { RollbackSignal } from '@application/errors/rollback-signal';
import type { TransactionKind } from '@application/ports/unit-of-work.port';
import { loadConfig } from '@infrastructure/config/env.schema';
import { MikroOrmUnitOfWork } from '@infrastructure/persistence/mikro-orm-unit-of-work';
import type { RepositoriesFactory } from '@infrastructure/persistence/mikro-orm-unit-of-work';
import { closeOrmInstances, openOrmInstances } from '@infrastructure/persistence/orm-instances';
import type { OrmInstances } from '@infrastructure/persistence/orm-instances';
import { OutboxMessageRecord } from '@infrastructure/persistence/records/outbox-messages.record';
import { WalletRecord } from '@infrastructure/persistence/records/wallets.record';
import { createRepositories } from '@infrastructure/persistence/repositories.factory';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';

const WALLET_ID = '0198b000-0000-7000-8000-000000000001';
const PLAYER_ID = '0198b000-0000-7000-8000-000000000002';
const OUTBOX_ID = '0198b000-0000-7000-8000-000000000003';
const NOW = new Date('2026-10-24T12:00:00.000Z');

class MissingEntityManagerError extends Error {
  constructor() {
    super('no entity manager was handed to the repositories');
    this.name = 'MissingEntityManagerError';
  }
}

interface Counts {
  readonly wallets: number;
  readonly outbox: number;
}

interface ConflictOutcome {
  readonly status: 'conflict';
  readonly transactionId: string;
}

const persistWalletAndOutbox = (em: EntityManager): void => {
  em.persist(
    new WalletRecord({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      currency: 'BRL',
      balance: '0.00',
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
  em.persist(
    new OutboxMessageRecord({
      id: OUTBOX_ID,
      aggregateId: WALLET_ID,
      eventType: 'WalletBalanceChanged',
      payload: { walletId: WALLET_ID },
      occurredAt: NOW,
      attempts: 0,
      permanentFailures: 0,
      nextAttemptAt: NOW,
      lockedUntil: null,
      lockedBy: null,
      publishedAt: null,
      parkedAt: null,
      lastErrorCode: null,
    }),
  );
};

const countRows = async (database: TestDatabase): Promise<Counts> => {
  const client = new Client({ connectionString: database.appUrl });
  await client.connect();
  try {
    const result = await client.query<Counts>(
      `SELECT (SELECT count(*)::int FROM wallets) AS wallets,
              (SELECT count(*)::int FROM outbox_messages) AS outbox`,
    );
    return result.rows[0] ?? { wallets: -1, outbox: -1 };
  } finally {
    await client.end();
  }
};

const failureOf = <T>(promise: Promise<T>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );

describe('RollbackSignal through the unit of work', () => {
  let database: TestDatabase;
  let instances: OrmInstances;
  let uow: MikroOrmUnitOfWork;
  let seen: EntityManager[];

  const currentEm = (): EntityManager => {
    const em = seen.at(-1);
    if (em === undefined) {
      throw new MissingEntityManagerError();
    }
    return em;
  };

  beforeEach(async () => {
    database = await createTestDatabase();
    const config = loadConfig({ DATABASE_URL: database.appUrl }, { role: 'api' });
    instances = await openOrmInstances(config);
    seen = [];
    const factory: RepositoriesFactory = (em) => {
      seen.push(em);
      return createRepositories(em);
    };
    uow = new MikroOrmUnitOfWork(instances, config, factory);
  });

  afterEach(async () => {
    await closeOrmInstances(instances);
  });

  it('undoes flushed writes and rethrows the very same signal', async () => {
    const signal = new RollbackSignal<ConflictOutcome>({
      status: 'conflict',
      transactionId: WALLET_ID,
    });
    const failure = await failureOf(
      uow.run('write', async (repos) => {
        persistWalletAndOutbox(currentEm());
        await repos.flush();
        throw signal;
      }),
    );
    expect(failure).toBe(signal);
    expect(failure).toBeInstanceOf(RollbackSignal);
    expect(Reflect.get(Object(failure), 'result')).toEqual({
      status: 'conflict',
      transactionId: WALLET_ID,
    });
    expect(Reflect.get(Object(failure), 'cause')).toBeUndefined();
    expect(await countRows(database)).toEqual({ wallets: 0, outbox: 0 });
  });

  it('discards changes that were never flushed', async () => {
    const signal = new RollbackSignal('replayed');
    const failure = await failureOf(
      uow.run('write', () => {
        persistWalletAndOutbox(currentEm());
        return Promise.reject(signal);
      }),
    );
    expect(failure).toBe(signal);
    expect(await countRows(database)).toEqual({ wallets: 0, outbox: 0 });
  });

  it('passes the signal untouched for every transaction kind', async () => {
    const kinds: readonly TransactionKind[] = ['write', 'short', 'reconciliation'];
    const failures = await Promise.all(
      kinds.map((kind) => {
        const signal = new RollbackSignal(kind);
        return failureOf(uow.run(kind, () => Promise.reject(signal))).then((failure) => {
          const result: unknown = Reflect.get(Object(failure), 'result');
          return { same: failure === signal, result };
        });
      }),
    );
    expect(failures).toEqual(
      kinds.map((kind) => ({
        same: true,
        result: kind,
      })),
    );
  });

  it('leaves the connection usable after rolling back on a signal', async () => {
    await failureOf(uow.run('write', () => Promise.reject(new RollbackSignal(undefined))));
    await uow.run('write', async (repos) => {
      persistWalletAndOutbox(currentEm());
      await repos.flush();
    });
    expect(await countRows(database)).toEqual({ wallets: 1, outbox: 1 });
  });
});
