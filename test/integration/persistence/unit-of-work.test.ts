import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Client } from 'pg';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import type { TechnicalReason } from '@application/errors/error-class';
import { loadConfig } from '@infrastructure/config/env.schema';
import type { AppConfig } from '@infrastructure/config/env.schema';
import { buildOrmOptions } from '@infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '@infrastructure/persistence/mikro-orm-unit-of-work';
import type { RepositoriesFactory } from '@infrastructure/persistence/mikro-orm-unit-of-work';
import { closeOrmInstances, openOrmInstances } from '@infrastructure/persistence/orm-instances';
import type { OrmInstances } from '@infrastructure/persistence/orm-instances';
import { OutboxMessageRecord } from '@infrastructure/persistence/records/outbox-messages.record';
import { WalletRecord } from '@infrastructure/persistence/records/wallets.record';
import { createRepositories } from '@infrastructure/persistence/repositories.factory';
import { ENTITY_SCHEMAS } from '@infrastructure/persistence/schemas';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';

const WALLET_ID = '0198a000-0000-7000-8000-000000000001';
const PLAYER_ID = '0198a000-0000-7000-8000-000000000002';
const OUTBOX_ID = '0198a000-0000-7000-8000-000000000003';
const NOW = new Date('2026-10-24T12:00:00.000Z');

class MissingEntityManagerError extends Error {
  constructor() {
    super('no entity manager was handed to the repositories');
    this.name = 'MissingEntityManagerError';
  }
}

interface Settings {
  readonly lockTimeout: string;
  readonly statementTimeout: string;
  readonly transactionTimeout: string;
  readonly isolation: string;
  readonly readOnly: string;
}

interface Counts {
  readonly wallets: number;
  readonly outbox: number;
}

const newWallet = (): WalletRecord =>
  new WalletRecord({
    id: WALLET_ID,
    playerId: PLAYER_ID,
    currency: 'BRL',
    balance: '0.00',
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });

const newOutboxMessage = (): OutboxMessageRecord =>
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
  });

const readSettings = async (em: EntityManager): Promise<Settings> => {
  const rows = await em.execute<
    { lock: string; statement: string; transaction: string; isolation: string; read_only: string }[]
  >(
    `SELECT current_setting('lock_timeout') AS lock,
            current_setting('statement_timeout') AS statement,
            current_setting('transaction_timeout') AS transaction,
            current_setting('transaction_isolation') AS isolation,
            current_setting('transaction_read_only') AS read_only`,
  );
  const row = rows[0];
  return {
    lockTimeout: row?.lock ?? '',
    statementTimeout: row?.statement ?? '',
    transactionTimeout: row?.transaction ?? '',
    isolation: row?.isolation ?? '',
    readOnly: row?.read_only ?? '',
  };
};

const showSetting = async (em: EntityManager, name: string): Promise<string> => {
  const rows = await em.execute<Record<string, string>[]>(`SHOW ${name}`);
  return rows[0]?.[name] ?? '';
};

const statementStartsTransaction = async (em: EntityManager): Promise<boolean> => {
  await em.execute('SELECT pg_sleep(0.05)');
  const rows = await em.execute<{ fresh: boolean }[]>(
    'SELECT now() = statement_timestamp() AS fresh',
  );
  return rows[0]?.fresh === true;
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

const capture = (): { factory: RepositoriesFactory; seen: EntityManager[] } => {
  const seen: EntityManager[] = [];
  const factory: RepositoriesFactory = (em) => {
    seen.push(em);
    return createRepositories(em);
  };
  return { factory, seen };
};

const lastOf = (seen: readonly EntityManager[]): EntityManager => {
  const em = seen.at(-1);
  if (em === undefined) {
    throw new MissingEntityManagerError();
  }
  return em;
};

const failureOf = <T>(promise: Promise<T>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );

const expectTechnical = (
  failure: unknown,
  errorClass: ErrorClass,
  reason: TechnicalReason,
): TechnicalError => {
  expect(failure).toBeInstanceOf(TechnicalError);
  expect(Reflect.get(Object(failure), 'errorClass')).toBe(errorClass);
  expect(Reflect.get(Object(failure), 'reason')).toBe(reason);
  return failure instanceof TechnicalError
    ? failure
    : new TechnicalError(ErrorClass.Deterministic, 'deterministic');
};

describe('MikroOrmUnitOfWork', () => {
  let database: TestDatabase;
  let opened: OrmInstances[] = [];

  const configFor = (overrides: Record<string, string> = {}): AppConfig =>
    loadConfig({ DATABASE_URL: database.appUrl, ...overrides }, { role: 'api' });

  const openUnitOfWork = async (
    overrides: Record<string, string> = {},
  ): Promise<{ uow: MikroOrmUnitOfWork; seen: EntityManager[]; instances: OrmInstances }> => {
    const config = configFor(overrides);
    const instances = await openOrmInstances(config);
    opened.push(instances);
    const { factory, seen } = capture();
    return { uow: new MikroOrmUnitOfWork(instances, config, factory), seen, instances };
  };

  beforeEach(async () => {
    database = await createTestDatabase();
  });

  afterEach(async () => {
    await Promise.all(opened.map(closeOrmInstances));
    opened = [];
  });

  describe('transaction settings', () => {
    it('opens write transactions in READ COMMITTED with the configured timeouts', async () => {
      const { uow, seen } = await openUnitOfWork({
        DB_LOCK_TIMEOUT_MS: '1500',
        DB_STATEMENT_TIMEOUT_MS: '4500',
        DB_TRANSACTION_TIMEOUT_MS: '12000',
      });
      const settings = await uow.run('write', () => readSettings(lastOf(seen)));
      expect(settings).toEqual({
        lockTimeout: '1500ms',
        statementTimeout: '4500ms',
        transactionTimeout: '12s',
        isolation: 'read committed',
        readOnly: 'off',
      });
    });

    it('uses the default write timeouts from the configuration', async () => {
      const { uow, seen } = await openUnitOfWork();
      const values = await uow.run('write', async () => {
        const em = lastOf(seen);
        return [
          await showSetting(em, 'lock_timeout'),
          await showSetting(em, 'statement_timeout'),
          await showSetting(em, 'transaction_timeout'),
        ];
      });
      expect(values).toEqual(['3s', '5s', '15s']);
    });

    it('opens short transactions in READ COMMITTED with the short timeouts', async () => {
      const { uow, seen } = await openUnitOfWork();
      const settings = await uow.run('short', () => readSettings(lastOf(seen)));
      expect(settings).toEqual({
        lockTimeout: '1s',
        statementTimeout: '2s',
        transactionTimeout: '0',
        isolation: 'read committed',
        readOnly: 'off',
      });
    });

    it('opens reconciliation transactions as REPEATABLE READ READ ONLY on its own ORM', async () => {
      const { uow, seen, instances } = await openUnitOfWork();
      const settings = await uow.run('reconciliation', () => readSettings(lastOf(seen)));
      expect(settings).toEqual({
        lockTimeout: '0',
        statementTimeout: '1min',
        transactionTimeout: '0',
        isolation: 'repeatable read',
        readOnly: 'on',
      });
      expect(lastOf(seen).getDriver()).toBe(instances.reconciliation.em.getDriver());
      expect(lastOf(seen).getDriver()).not.toBe(instances.main.em.getDriver());
    });

    it('keeps the local settings inside the transaction', async () => {
      const { uow, seen } = await openUnitOfWork({ DB_POOL_MAX: '1' });
      await uow.run('write', () => Promise.resolve());
      const after = await uow.read(() => showSetting(lastOf(seen), 'lock_timeout'));
      expect(after).toBe('0');
    });
  });

  describe('entity managers', () => {
    it('forks a clear entity manager for every run', async () => {
      const { uow, seen, instances } = await openUnitOfWork();
      await uow.run('write', async (repos) => {
        lastOf(seen).persist(newWallet());
        await repos.flush();
      });
      const loadedInFirst = await uow.run('write', async () => {
        const em = lastOf(seen);
        const sizeBefore = em.getUnitOfWork().getIdentityMap().values().length;
        await em.findOneOrFail(WalletRecord, WALLET_ID);
        return sizeBefore;
      });
      const sizeInNext = await uow.run('write', () =>
        Promise.resolve(lastOf(seen).getUnitOfWork().getIdentityMap().values().length),
      );
      expect(loadedInFirst).toBe(0);
      expect(sizeInNext).toBe(0);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).not.toContain(instances.main.em);
    });

    it('flushes pending changes inside the transaction through repos.flush', async () => {
      const { uow, seen } = await openUnitOfWork();
      const inside = await uow.run('write', async (repos) => {
        const em = lastOf(seen);
        em.persist(newWallet());
        em.persist(newOutboxMessage());
        await repos.flush();
        return em.execute<{ wallets: number; outbox: number }[]>(
          `SELECT (SELECT count(*)::int FROM wallets) AS wallets,
                  (SELECT count(*)::int FROM outbox_messages) AS outbox`,
        );
      });
      expect(inside).toEqual([{ wallets: 1, outbox: 1 }]);
      expect(await countRows(database)).toEqual({ wallets: 1, outbox: 1 });
    });

    it('reads without opening a transaction', async () => {
      const { uow, seen } = await openUnitOfWork();
      const fromRead = await uow.read(async (repos) => {
        const em = lastOf(seen);
        return {
          slots: Object.keys(repos).sort(),
          inTransaction: em.isInTransaction(),
          autocommit: await statementStartsTransaction(em),
        };
      });
      const fromRun = await uow.run('write', () => statementStartsTransaction(lastOf(seen)));
      expect(fromRead).toEqual({
        slots: ['idempotency', 'inbox', 'ledger', 'transactions', 'wallets'],
        inTransaction: false,
        autocommit: true,
      });
      expect(fromRun).toBe(false);
    });
  });

  describe('failures', () => {
    it('rolls back everything, outbox included, when the work throws', async () => {
      const { uow, seen } = await openUnitOfWork();
      const original = new Error('work failed');
      const failure = await failureOf(
        uow.run('write', async (repos) => {
          const em = lastOf(seen);
          em.persist(newWallet());
          em.persist(newOutboxMessage());
          await repos.flush();
          throw original;
        }),
      );
      const technical = expectTechnical(failure, ErrorClass.Deterministic, 'deterministic');
      expect(technical.cause).toBe(original);
      expect(await countRows(database)).toEqual({ wallets: 0, outbox: 0 });
    });

    it('classifies a statement cancelled by the short statement timeout', async () => {
      const { uow, seen } = await openUnitOfWork();
      const failure = await failureOf(
        uow.run('short', () => lastOf(seen).execute('SELECT pg_sleep(3)')),
      );
      expectTechnical(failure, ErrorClass.Transient, 'statement_timeout');
    });

    it('gives up acquiring a connection after the connect timeout', async () => {
      const { uow } = await openUnitOfWork({ DB_POOL_MAX: '1', DB_CONNECT_TIMEOUT_MS: '500' });
      const release: PromiseWithResolvers<void> = Promise.withResolvers();
      const started: PromiseWithResolvers<void> = Promise.withResolvers();
      const holder = uow.run('write', () => {
        started.resolve();
        return release.promise;
      });
      await started.promise;
      const startedAt = performance.now();
      const failure = await failureOf(uow.run('write', () => Promise.resolve()));
      const elapsedMs = performance.now() - startedAt;
      release.resolve();
      await holder;
      expectTechnical(failure, ErrorClass.Connectivity, 'pool_exhausted');
      const cause: unknown = Reflect.get(Object(failure), 'cause');
      const causeMessage: unknown = Reflect.get(Object(cause), 'message');
      expect(String(causeMessage).startsWith('Knex: Timeout acquiring a connection')).toBe(true);
      expect(elapsedMs).toBeGreaterThanOrEqual(400);
      expect(elapsedMs).toBeLessThan(5000);
    });

    it('stops waiting for a query after the client query timeout', async () => {
      const { uow, seen } = await openUnitOfWork({
        DB_QUERY_TIMEOUT_MS: '300',
        DB_STATEMENT_TIMEOUT_MS: '5000',
      });
      const failure = await failureOf(
        uow.run('write', () => lastOf(seen).execute('SELECT pg_sleep(1)')),
      );
      expectTechnical(failure, ErrorClass.Connectivity, 'connection');
    });
  });

  describe('ORM options', () => {
    it('configures pool acquisition and query timeouts per kind', () => {
      const config = loadConfig(
        {
          DATABASE_URL: database.appUrl,
          MIGRATION_DATABASE_URL: database.ownerUrl,
          DB_CONNECT_TIMEOUT_MS: '1234',
          DB_POOL_MAX: '7',
          DB_QUERY_TIMEOUT_MS: '4321',
          RECONCILIATION_POOL_MAX: '3',
          RECONCILIATION_QUERY_TIMEOUT_MS: '54321',
        },
        { role: 'api' },
      );
      const summary = (kind: 'main' | 'reconciliation' | 'migrator'): unknown => {
        const options = buildOrmOptions(kind, config);
        const connection: unknown = Reflect.get(Object(options.driverOptions), 'connection');
        const queryTimeout: unknown = Reflect.get(Object(connection), 'query_timeout');
        const connectionTimeout: unknown = Reflect.get(
          Object(connection),
          'connectionTimeoutMillis',
        );
        return {
          clientUrl: options.clientUrl,
          entities: options.entities,
          allowGlobalContext: options.allowGlobalContext,
          pool: options.pool,
          queryTimeout,
          connectionTimeout,
        };
      };
      const pool = (max: number): unknown => ({ min: 0, max, acquireTimeoutMillis: 1234 });
      expect(summary('main')).toEqual({
        clientUrl: database.appUrl,
        entities: ENTITY_SCHEMAS,
        allowGlobalContext: false,
        pool: pool(7),
        queryTimeout: 4321,
        connectionTimeout: 1234,
      });
      expect(summary('reconciliation')).toEqual({
        clientUrl: database.appUrl,
        entities: ENTITY_SCHEMAS,
        allowGlobalContext: false,
        pool: pool(3),
        queryTimeout: 54321,
        connectionTimeout: 1234,
      });
      expect(summary('migrator')).toEqual({
        clientUrl: database.ownerUrl,
        entities: ENTITY_SCHEMAS,
        allowGlobalContext: false,
        pool: pool(1),
        queryTimeout: undefined,
        connectionTimeout: 1234,
      });
    });
  });
});
