import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { DriverException, IsolationLevel, LockMode } from '@mikro-orm/core';
import { MikroORM, PostgreSqlDriver } from '@mikro-orm/postgresql';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Client } from 'pg';
import { NotFoundError } from '@application/errors/not-found.error';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import type { TechnicalReason } from '@application/errors/error-class';
import { RollbackSignal } from '@application/errors/rollback-signal';
import { CurrencyMismatchError } from '@domain/shared/errors/currency-mismatch.error';
import { pgErrorClassifier } from '@infrastructure/persistence/pg-error-classifier';
import { WalletRecord } from '@infrastructure/persistence/records/wallets.record';
import { ENTITY_SCHEMAS } from '@infrastructure/persistence/schemas';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { waitFor } from '@test/support/wait-for';

const WALLET_ID = '0196b000-0000-7000-8000-000000000001';
const OTHER_WALLET_ID = '0196b000-0000-7000-8000-000000000002';
const PLAYER_ID = '0196b000-0000-7000-8000-000000000003';
const OTHER_PLAYER_ID = '0196b000-0000-7000-8000-000000000004';
const BET_ID = '0196b000-0000-7000-8000-000000000005';
const SECOND_TX_ID = '0196b000-0000-7000-8000-000000000006';
const THIRD_TX_ID = '0196b000-0000-7000-8000-000000000007';
const HOUSE_ID = '0196b000-0000-7000-8000-000000000008';
const OTHER_HOUSE_ID = '0196b000-0000-7000-8000-000000000009';
const HASH = 'b'.repeat(64);
const JOB_NAME = 'global-reconciliation';
const WAIT = { timeoutMs: 5000, intervalMs: 20 };

const INSERT_WALLET = `INSERT INTO wallets (id, player_id, currency, balance, created_at, updated_at)
VALUES (?, ?, 'BRL', 0, now(), now())`;

const INSERT_TRANSACTION = `INSERT INTO wager_transactions (
  id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
  round_id, game_id, kind, amount, currency, reference_external_transaction_id,
  reference_transaction_id, status, failure_code, correlation_id, created_at, processed_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, 'round-1', 'game-1', ?, 10, 'BRL', ?, ?, ?, ?, 'corr-1', now(), ?, now())`;

const INSERT_IDEMPOTENCY = `INSERT INTO idempotency_records (
  provider_id, idempotency_key, payload_hash, transaction_id, http_status, response_body, created_at, updated_at
) VALUES ('provider-a', 'key-1', ?, NULL, ?, '{}', now(), now())`;

const INSERT_INBOX = `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
VALUES ('wager-transactions-consumer', 'message-1', ?, now())`;

const INSERT_HOUSE = `INSERT INTO house_accounts (id, currency, purpose, created_at)
VALUES (?, 'BRL', 'GAMING', now())`;

const LOCK_WALLET = 'SELECT id FROM wallets WHERE id = ? FOR UPDATE';

interface TransactionRow {
  readonly id: string;
  readonly providerId?: string;
  readonly externalId: string;
  readonly key: string;
  readonly kind?: string;
  readonly status?: string;
  readonly referenceExternalId?: string;
  readonly referenceId?: string;
}

interface OrmTuning {
  readonly poolMax?: number;
  readonly acquireTimeoutMs?: number;
  readonly queryTimeoutMs?: number;
  readonly connect?: boolean;
}

const insertWallet = async (em: EntityManager, id = WALLET_ID, playerId = PLAYER_ID) => {
  await em.execute(INSERT_WALLET, [id, playerId]);
};

const insertTransaction = async (em: EntityManager, row: TransactionRow): Promise<void> => {
  const status = row.status ?? 'REJECTED';
  await em.execute(INSERT_TRANSACTION, [
    row.id,
    row.providerId ?? 'provider-a',
    row.externalId,
    row.key,
    HASH,
    WALLET_ID,
    PLAYER_ID,
    row.kind ?? 'BET',
    row.referenceExternalId ?? null,
    row.referenceId ?? null,
    status,
    status === 'REJECTED' ? 'INSUFFICIENT_FUNDS' : null,
    status === 'PROCESSED' ? new Date('2026-10-24T12:00:00.000Z') : null,
  ]);
};

const propertyOf = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;

const failureOf = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (error: unknown) => error,
  );

const expectTechnical = (
  original: unknown,
  errorClass: TechnicalError['errorClass'],
  reason: TechnicalReason,
): TechnicalError => {
  expect(original).toBeDefined();
  const wrapped = pgErrorClassifier.wrap(original);
  expect(wrapped).toBeInstanceOf(TechnicalError);
  if (!(wrapped instanceof TechnicalError)) {
    throw wrapped;
  }
  expect(wrapped.errorClass).toBe(errorClass);
  expect(wrapped.reason).toBe(reason);
  expect(wrapped.cause).toBe(original);
  expect(wrapped.message).toBe(`${errorClass}: ${reason}`);
  return wrapped;
};

const expectConnectivity = (original: unknown, reason: TechnicalReason): void => {
  expect(expectTechnical(original, ErrorClass.Connectivity, reason).probe).toBe('database');
};

const connectClient = async (url: string): Promise<Client> => {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
};

describe('pgErrorClassifier', () => {
  let database: TestDatabase;
  let opened: MikroORM[] = [];

  const openOrm = async (clientUrl: string, tuning: OrmTuning = {}): Promise<MikroORM> => {
    const orm = await MikroORM.init({
      driver: PostgreSqlDriver,
      clientUrl,
      connect: tuning.connect ?? true,
      entities: ENTITY_SCHEMAS,
      debug: false,
      forceUtcTimezone: true,
      allowGlobalContext: false,
      pool: {
        min: 0,
        max: tuning.poolMax ?? 4,
        acquireTimeoutMillis: tuning.acquireTimeoutMs ?? 2000,
      },
      driverOptions: {
        connection:
          tuning.queryTimeoutMs === undefined ? {} : { query_timeout: tuning.queryTimeoutMs },
      },
    });
    opened.push(orm);
    return orm;
  };

  const appEm = async (tuning: OrmTuning = {}): Promise<EntityManager> =>
    (await openOrm(database.appUrl, tuning)).em.fork();

  beforeEach(async () => {
    database = await createTestDatabase();
  });

  afterEach(async () => {
    await Promise.all(opened.map((orm) => orm.close(true)));
    opened = [];
  });

  describe('race constraints', () => {
    const raceCases: readonly {
      readonly constraint: string;
      readonly provoke: (em: EntityManager) => Promise<void>;
    }[] = [
      {
        constraint: 'wallets_player_currency_uq',
        provoke: async (em) => {
          await insertWallet(em);
          await insertWallet(em, OTHER_WALLET_ID, PLAYER_ID);
        },
      },
      {
        constraint: 'wager_transactions_provider_external_uq',
        provoke: async (em) => {
          await insertWallet(em);
          await insertTransaction(em, { id: BET_ID, externalId: 'ext-1', key: 'key-1' });
          await insertTransaction(em, { id: SECOND_TX_ID, externalId: 'ext-1', key: 'key-2' });
        },
      },
      {
        constraint: 'wager_transactions_provider_key_uq',
        provoke: async (em) => {
          await insertWallet(em);
          await insertTransaction(em, { id: BET_ID, externalId: 'ext-1', key: 'key-1' });
          await insertTransaction(em, { id: SECOND_TX_ID, externalId: 'ext-2', key: 'key-1' });
        },
      },
      {
        constraint: 'wager_transactions_single_reversal_uq',
        provoke: async (em) => {
          await insertWallet(em);
          await insertTransaction(em, {
            id: BET_ID,
            externalId: 'ext-1',
            key: 'key-1',
            status: 'PROCESSED',
          });
          for (const [id, suffix] of [
            [SECOND_TX_ID, '2'],
            [THIRD_TX_ID, '3'],
          ] as const) {
            await insertTransaction(em, {
              id,
              externalId: `ext-${suffix}`,
              key: `key-${suffix}`,
              kind: 'ROLLBACK',
              status: 'PROCESSED',
              referenceExternalId: 'ext-1',
              referenceId: BET_ID,
            });
          }
        },
      },
      {
        constraint: 'idempotency_records_pkey',
        provoke: async (em) => {
          await em.execute(INSERT_IDEMPOTENCY, [HASH, 202]);
          await em.execute(INSERT_IDEMPOTENCY, [HASH, 202]);
        },
      },
      {
        constraint: 'inbox_messages_pkey',
        provoke: async (em) => {
          await em.execute(INSERT_INBOX, [HASH]);
          await em.execute(INSERT_INBOX, [HASH]);
        },
      },
    ];

    for (const raceCase of raceCases) {
      it(`classifies a unique violation of ${raceCase.constraint} as race`, async () => {
        const em = await appEm();
        const error = await failureOf(em.transactional(raceCase.provoke));
        const wrapped = expectTechnical(error, ErrorClass.Race, 'race');
        expect(wrapped.constraint).toBe(raceCase.constraint);
      });
    }
  });

  describe('deterministic constraints', () => {
    const deterministicCases: readonly {
      readonly name: string;
      readonly provoke: (em: EntityManager) => Promise<void>;
    }[] = [
      {
        name: 'a unique violation outside the race list',
        provoke: async (em) => {
          await em.execute(INSERT_HOUSE, [HOUSE_ID]);
          await em.execute(INSERT_HOUSE, [OTHER_HOUSE_ID]);
        },
      },
      {
        name: 'a second opening for the same wallet',
        provoke: async (em) => {
          await insertWallet(em);
          for (const id of [BET_ID, SECOND_TX_ID]) {
            await insertTransaction(em, {
              id,
              providerId: '__system__',
              externalId: id,
              key: id,
              kind: 'OPENING',
              status: 'PROCESSED',
            });
          }
        },
      },
      {
        name: 'a check violation',
        provoke: async (em) => {
          await em.execute(
            `INSERT INTO wallets (id, player_id, currency, balance, created_at, updated_at)
VALUES (?, ?, 'BRL', -1, now(), now())`,
            [WALLET_ID, PLAYER_ID],
          );
        },
      },
      {
        name: 'a foreign key violation',
        provoke: async (em) => {
          await insertTransaction(em, { id: BET_ID, externalId: 'ext-1', key: 'key-1' });
        },
      },
      {
        name: 'a not null violation',
        provoke: async (em) => {
          await em.execute(INSERT_WALLET, [WALLET_ID, null]);
        },
      },
      {
        name: 'a missing privilege',
        provoke: async (em) => {
          await insertWallet(em);
          await em.execute('DELETE FROM wallets WHERE id = ?', [WALLET_ID]);
        },
      },
    ];

    for (const deterministicCase of deterministicCases) {
      it(`classifies ${deterministicCase.name} as deterministic`, async () => {
        const em = await appEm();
        const error = await failureOf(em.transactional(deterministicCase.provoke));
        expectTechnical(error, ErrorClass.Deterministic, 'deterministic');
      });
    }

    it('reports the permission failure with sqlstate 42501', async () => {
      const em = await appEm();
      const error = await failureOf(
        em.execute('UPDATE wallets SET player_id = ? WHERE id = ?', [OTHER_PLAYER_ID, WALLET_ID]),
      );
      expect(propertyOf(error, 'code')).toBe('42501');
      expectTechnical(error, ErrorClass.Deterministic, 'deterministic');
    });
  });

  describe('guards', () => {
    it('classifies JG001 from a truncate of the ledger as deterministic', async () => {
      const em = (await openOrm(database.ownerUrl)).em.fork();
      const error = await failureOf(em.execute('TRUNCATE ledger_entries'));
      expect(propertyOf(error, 'code')).toBe('JG001');
      expectTechnical(error, ErrorClass.Deterministic, 'deterministic');
    });

    it('classifies JG002 from a wallet born with version 2 as deterministic', async () => {
      const em = await appEm();
      const error = await failureOf(
        em.execute(
          `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
VALUES (?, ?, 'BRL', 0, 2, now(), now())`,
          [WALLET_ID, PLAYER_ID],
        ),
      );
      expect(propertyOf(error, 'code')).toBe('JG002');
      expectTechnical(error, ErrorClass.Deterministic, 'deterministic');
    });

    it('classifies JG005 from an update of a terminal transaction as deterministic', async () => {
      const em = await appEm();
      await insertWallet(em);
      await insertTransaction(em, { id: BET_ID, externalId: 'ext-1', key: 'key-1' });
      const error = await failureOf(
        em.execute(
          `UPDATE wager_transactions SET status = 'FAILED', failure_code = 'PROCESSING_FAILED'
WHERE id = ?`,
          [BET_ID],
        ),
      );
      expect(propertyOf(error, 'code')).toBe('JG005');
      expectTechnical(error, ErrorClass.Deterministic, 'deterministic');
    });

    it('classifies JG006 from a wallet delete as deterministic', async () => {
      await insertWallet(await appEm());
      const em = (await openOrm(database.ownerUrl)).em.fork();
      const error = await failureOf(em.execute('DELETE FROM wallets WHERE id = ?', [WALLET_ID]));
      expect(propertyOf(error, 'code')).toBe('JG006');
      expectTechnical(error, ErrorClass.Deterministic, 'deterministic');
    });

    it('classifies JG007 from an update of a final idempotency record as deterministic', async () => {
      const em = await appEm();
      await em.execute(INSERT_IDEMPOTENCY, [HASH, 200]);
      const error = await failureOf(
        em.execute(
          `UPDATE idempotency_records SET http_status = 422
WHERE provider_id = 'provider-a' AND idempotency_key = 'key-1'`,
        ),
      );
      expect(propertyOf(error, 'code')).toBe('JG007');
      expectTechnical(error, ErrorClass.Deterministic, 'deterministic');
    });
  });

  describe('transient failures', () => {
    const holdWalletLock = async (): Promise<Client> => {
      await insertWallet(await appEm());
      const holder = await connectClient(database.appUrl);
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [WALLET_ID]);
      return holder;
    };

    it('classifies 55P03 from lock_timeout as lock_timeout', async () => {
      const holder = await holdWalletLock();
      try {
        const em = await appEm();
        const error = await failureOf(
          em.transactional(async (tx) => {
            await tx.execute(`SET LOCAL lock_timeout = '100ms'`);
            await tx.execute(LOCK_WALLET, [WALLET_ID]);
          }),
        );
        expect(propertyOf(error, 'code')).toBe('55P03');
        expectTechnical(error, ErrorClass.Transient, 'lock_timeout');
      } finally {
        await holder.query('ROLLBACK');
        await holder.end();
      }
    });

    it('classifies 55P03 from NOWAIT as lock_timeout', async () => {
      const holder = await holdWalletLock();
      try {
        const em = await appEm();
        const error = await failureOf(
          em.execute('SELECT id FROM wallets WHERE id = ? FOR UPDATE NOWAIT', [WALLET_ID]),
        );
        expect(propertyOf(error, 'code')).toBe('55P03');
        expectTechnical(error, ErrorClass.Transient, 'lock_timeout');
      } finally {
        await holder.query('ROLLBACK');
        await holder.end();
      }
    });

    it('classifies 57014 as statement_timeout', async () => {
      const em = await appEm();
      const error = await failureOf(
        em.transactional(async (tx) => {
          await tx.execute(`SET LOCAL statement_timeout = '50ms'`);
          await tx.execute('SELECT pg_sleep(2)');
        }),
      );
      expect(propertyOf(error, 'code')).toBe('57014');
      expectTechnical(error, ErrorClass.Transient, 'statement_timeout');
    });

    it('classifies 25P04 as transaction_timeout', async () => {
      const em = await appEm();
      const error = await failureOf(
        em.transactional(async (tx) => {
          await tx.execute(`SET LOCAL transaction_timeout = '100ms'`);
          await tx.execute('SELECT pg_sleep(2)');
        }),
      );
      expect(propertyOf(error, 'code')).toBe('25P04');
      expectTechnical(error, ErrorClass.Transient, 'transaction_timeout');
    });

    it('classifies 40001 as serialization', async () => {
      const em = await appEm();
      const other = await connectClient(database.appUrl);
      try {
        const error = await failureOf(
          em.transactional(
            async (tx) => {
              await tx.execute('SELECT locked_by FROM scheduled_jobs WHERE name = ?', [JOB_NAME]);
              await other.query(`UPDATE scheduled_jobs SET locked_by = 'other' WHERE name = $1`, [
                JOB_NAME,
              ]);
              await tx.execute(`UPDATE scheduled_jobs SET locked_by = 'mine' WHERE name = ?`, [
                JOB_NAME,
              ]);
            },
            { isolationLevel: IsolationLevel.REPEATABLE_READ },
          ),
        );
        expect(propertyOf(error, 'code')).toBe('40001');
        expectTechnical(error, ErrorClass.Transient, 'serialization');
      } finally {
        await other.end();
      }
    });

    it('classifies 40P01 as deadlock', async () => {
      const setup = await appEm();
      await insertWallet(setup);
      await insertWallet(setup, OTHER_WALLET_ID, OTHER_PLAYER_ID);
      const holder = await connectClient(database.appUrl);
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [OTHER_WALLET_ID]);
        const em = await appEm();
        const failure = failureOf(
          em.transactional(async (tx) => {
            await tx.execute(LOCK_WALLET, [WALLET_ID]);
            await tx.execute(LOCK_WALLET, [OTHER_WALLET_ID]);
          }),
        );
        await waitFor(async () => {
          const result = await holder.query<{ waiting: number }>(
            `SELECT count(*)::int AS waiting FROM pg_stat_activity
WHERE datname = current_database() AND wait_event_type = 'Lock'`,
          );
          return (result.rows[0]?.waiting ?? 0) > 0;
        }, WAIT);
        const holderLock = holder.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [
          WALLET_ID,
        ]);
        const error = await failure;
        await holderLock;
        expect(propertyOf(error, 'code')).toBe('40P01');
        expectTechnical(error, ErrorClass.Transient, 'deadlock');
      } finally {
        await holder.query('ROLLBACK');
        await holder.end();
      }
    });

    it('classifies an optimistic lock failure as version_mismatch', async () => {
      await insertWallet(await appEm());
      const em = await appEm();
      const wallet = await em.findOneOrFail(WalletRecord, WALLET_ID);
      const error = await failureOf(em.lock(wallet, LockMode.OPTIMISTIC, wallet.version + 1));
      expectTechnical(error, ErrorClass.Transient, 'version_mismatch');
    });
  });

  describe('connectivity failures', () => {
    it('classifies a backend killed by pg_terminate_backend as connection', async () => {
      const em = await appEm({ poolMax: 1 });
      const [row] = await em.execute<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
      const pid = row?.pid;
      expect(pid).toBeNumber();
      const sleeping = failureOf(em.execute('SELECT pg_sleep(5)'));
      const admin = await connectClient(database.superuserUrl);
      try {
        await waitFor(async () => {
          const result = await admin.query<{ sleeping: number }>(
            `SELECT count(*)::int AS sleeping FROM pg_stat_activity
WHERE pid = $1 AND wait_event = 'PgSleep'`,
            [pid],
          );
          return (result.rows[0]?.sleeping ?? 0) > 0;
        }, WAIT);
        await admin.query('SELECT pg_terminate_backend($1)', [pid]);
      } finally {
        await admin.end();
      }
      const error = await sleeping;
      expect(propertyOf(error, 'code')).toBe('57P01');
      expectConnectivity(error, 'connection');
    });

    it('classifies a client query read timeout as connection', async () => {
      const em = await appEm({ queryTimeoutMs: 100 });
      const error = await failureOf(em.execute('SELECT pg_sleep(1)'));
      expect(propertyOf(error, 'message')).toContain('Query read timeout');
      expectConnectivity(error, 'connection');
    });

    it('classifies a refused connection as connection', async () => {
      const url = new URL(database.appUrl);
      url.hostname = '127.0.0.1';
      url.port = '1';
      const em = (await openOrm(url.toString(), { connect: false })).em.fork();
      const error = await failureOf(em.execute('SELECT 1'));
      expect(propertyOf(error, 'code')).toBe('ECONNREFUSED');
      expectConnectivity(error, 'connection');
    });

    it('classifies an exhausted pool by its message as pool_exhausted', async () => {
      const orm = await openOrm(database.appUrl, { poolMax: 1, acquireTimeoutMs: 200 });
      const started: PromiseWithResolvers<void> = Promise.withResolvers();
      const release: PromiseWithResolvers<void> = Promise.withResolvers();
      const holding = orm.em.fork().transactional(async (tx) => {
        await tx.execute('SELECT 1');
        started.resolve();
        await release.promise;
      });
      await started.promise;
      const error = await failureOf(orm.em.fork().execute('SELECT 1'));
      release.resolve();
      await holding;
      expect(error).toBeInstanceOf(DriverException);
      expect(propertyOf(error, 'name')).toBe('DriverException');
      expect(propertyOf(error, 'message')).toStartWith('Knex: Timeout acquiring a connection');
      expect(propertyOf(error, 'code')).toBeUndefined();
      expect(propertyOf(error, 'cause')).toBeUndefined();
      expectConnectivity(error, 'pool_exhausted');
    });

    it('classifies an exhausted pool when opening a transaction as pool_exhausted', async () => {
      const orm = await openOrm(database.appUrl, { poolMax: 1, acquireTimeoutMs: 200 });
      const started: PromiseWithResolvers<void> = Promise.withResolvers();
      const release: PromiseWithResolvers<void> = Promise.withResolvers();
      const holding = orm.em.fork().transactional(async (tx) => {
        await tx.execute('SELECT 1');
        started.resolve();
        await release.promise;
      });
      await started.promise;
      const error = await failureOf(orm.em.fork().transactional(() => Promise.resolve()));
      release.resolve();
      await holding;
      expect(error).not.toBeInstanceOf(DriverException);
      expect(propertyOf(error, 'message')).toStartWith('Knex: Timeout acquiring a connection');
      expectConnectivity(error, 'pool_exhausted');
    });

    it('classifies 57P03 cannot_connect_now as connection', () => {
      const starting = new DriverException(
        Object.assign(new Error('the database system is starting up'), { code: '57P03' }),
      );
      expectConnectivity(starting, 'connection');
    });

    it('finds Connection terminated anywhere in the driver message', () => {
      const terminated = new DriverException(
        new Error('select 1 - Connection terminated unexpectedly'),
      );
      expectConnectivity(terminated, 'connection');
    });

    it('classifies a finished transaction query as connection', () => {
      const finished = new DriverException(new Error('Transaction query already complete'));
      expectConnectivity(finished, 'connection');
    });

    it('follows the cause chain to a socket error code', () => {
      const socket = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      expectConnectivity(new Error('wrapped', { cause: socket }), 'connection');
    });
  });

  describe('insufficient resources', () => {
    const resourceCases: readonly { readonly code: string; readonly message: string }[] = [
      { code: '53300', message: 'sorry, too many clients already' },
      { code: '53000', message: 'insufficient resources' },
      { code: '53100', message: 'could not extend file: No space left on device' },
      { code: '53200', message: 'out of memory' },
      { code: '53400', message: 'configuration limit exceeded' },
    ];

    for (const resourceCase of resourceCases) {
      it(`classifies ${resourceCase.code} as transient`, () => {
        const exhausted = new DriverException(
          Object.assign(new Error(resourceCase.message), { code: resourceCase.code }),
        );
        const wrapped = expectTechnical(exhausted, ErrorClass.Transient, 'connection');
        expect(wrapped.probe).toBeUndefined();
      });
    }

    it('classifies a real too_many_connections rejection as transient', async () => {
      const role = `jungle_limited_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const admin = await connectClient(database.superuserUrl);
      try {
        await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'limited' CONNECTION LIMIT 0`);
        const url = new URL(database.appUrl);
        url.username = role;
        url.password = 'limited';
        const em = (await openOrm(url.toString(), { connect: false })).em.fork();
        const error = await failureOf(em.execute('SELECT 1'));
        expect(propertyOf(error, 'code')).toBe('53300');
        expectTechnical(error, ErrorClass.Transient, 'connection');
      } finally {
        await admin.query(`DROP ROLE IF EXISTS ${role}`);
        await admin.end();
      }
    });
  });

  describe('pass-through', () => {
    it('returns domain, application, technical and rollback errors untouched', () => {
      const errors: readonly unknown[] = [
        new RollbackSignal({ status: 409 }),
        new CurrencyMismatchError('currency mismatch'),
        new NotFoundError(),
        new TechnicalError(ErrorClass.Transient, 'lock_timeout'),
      ];
      for (const error of errors) {
        expect(pgErrorClassifier.wrap(error)).toBe(error);
      }
    });

    it('classifies an unknown error as deterministic', () => {
      expectTechnical(new Error('unknown'), ErrorClass.Deterministic, 'deterministic');
    });
  });
});
