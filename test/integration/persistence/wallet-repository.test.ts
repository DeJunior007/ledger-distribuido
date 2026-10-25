import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { DriverException, LockMode, LockWaitTimeoutException } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Client } from 'pg';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import type { TechnicalReason } from '@application/errors/error-class';
import type { Repositories } from '@application/ports/unit-of-work.port';
import { toCurrencyCode } from '@domain/shared/currency';
import { Money } from '@domain/shared/money';
import { Wallet } from '@domain/wallet/wallet';
import { loadConfig } from '@infrastructure/config/env.schema';
import { MikroOrmUnitOfWork } from '@infrastructure/persistence/mikro-orm-unit-of-work';
import type { RepositoriesFactory } from '@infrastructure/persistence/mikro-orm-unit-of-work';
import { closeOrmInstances, openOrmInstances } from '@infrastructure/persistence/orm-instances';
import type { OrmInstances } from '@infrastructure/persistence/orm-instances';
import { WalletRecord } from '@infrastructure/persistence/records/wallets.record';
import { createRepositories } from '@infrastructure/persistence/repositories.factory';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';

const CURRENCY = 'BRL';
const PROVIDER = 'provider-wallet-repository';
const SYSTEM_PROVIDER = '__system__';
const NOW = new Date('2026-10-24T12:00:00.000Z');

class MissingEntityManagerError extends Error {
  constructor() {
    super('no entity manager was handed to these repositories');
    this.name = 'MissingEntityManagerError';
  }
}

interface Seed {
  readonly walletId: string;
  readonly playerId: string;
  readonly gamingId: string;
}

interface StoredWallet {
  readonly balance: string;
  readonly version: number;
}

interface Movement {
  readonly amount: string;
  readonly gamingId: string;
}

const withClient = async <T>(url: string, work: (client: Client) => Promise<T>): Promise<T> => {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
};

const failureOf = <T>(promise: Promise<T>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );

const expectTechnical = (failure: unknown, errorClass: ErrorClass, reason: TechnicalReason) => {
  expect(failure).toBeInstanceOf(TechnicalError);
  expect(Reflect.get(Object(failure), 'errorClass')).toBe(errorClass);
  expect(Reflect.get(Object(failure), 'reason')).toBe(reason);
};

const seedEmptyWallet = async (database: TestDatabase): Promise<Seed> => {
  const seed: Seed = {
    walletId: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    gamingId: crypto.randomUUID(),
  };
  await withClient(database.ownerUrl, async (client) => {
    await client.query(
      `INSERT INTO house_accounts (id, currency, purpose, created_at) VALUES ($1, $2, 'GAMING', now())`,
      [seed.gamingId, CURRENCY],
    );
    await client.query(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES ($1, $2, $3, '0.00', 1, now(), now())`,
      [seed.walletId, seed.playerId, CURRENCY],
    );
  });
  return seed;
};

const MAX_BALANCE = '999999999999999999.99';

const seedFundedWallet = async (database: TestDatabase, balance = '100.00'): Promise<Seed> => {
  const seed: Seed = {
    walletId: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    gamingId: crypto.randomUUID(),
  };
  const fundingId = crypto.randomUUID();
  const openingId = crypto.randomUUID();
  await withClient(database.ownerUrl, async (client) => {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO house_accounts (id, currency, purpose, created_at)
       VALUES ($1, $3, 'FUNDING', now()), ($2, $3, 'GAMING', now())`,
      [fundingId, seed.gamingId, CURRENCY],
    );
    await client.query(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 1, now(), now())`,
      [seed.walletId, seed.playerId, CURRENCY, balance],
    );
    await client.query(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency, status, correlation_id, created_at,
         processed_at, updated_at)
       VALUES ($1, $2, $3, $3, repeat('a', 64), $4, $5, 'round-1', 'game-1', 'OPENING', $7, $6,
         'PROCESSED', 'correlation-1', now(), now(), now())`,
      [
        openingId,
        SYSTEM_PROVIDER,
        `opening-${seed.walletId}`,
        seed.walletId,
        seed.playerId,
        CURRENCY,
        balance,
      ],
    );
    await client.query(
      `INSERT INTO ledger_entries (id, transaction_id, account_kind, wallet_id, direction, amount, currency,
         balance_before, balance_after, wallet_version, created_at)
       VALUES ($1, $2, 'WALLET', $3, 'CREDIT', $5, $4, '0.00', $5, 1, now())`,
      [crypto.randomUUID(), openingId, seed.walletId, CURRENCY, balance],
    );
    await client.query(
      `INSERT INTO ledger_entries (id, transaction_id, account_kind, house_account_id, direction, amount, currency,
         created_at)
       VALUES ($1, $2, 'HOUSE', $3, 'DEBIT', $5, $4, now())`,
      [crypto.randomUUID(), openingId, fundingId, CURRENCY, balance],
    );
    await client.query('COMMIT');
  });
  return seed;
};

const storedWallet = (
  database: TestDatabase,
  walletId: string,
): Promise<StoredWallet | undefined> =>
  withClient(database.superuserUrl, async (client) => {
    const result = await client.query<StoredWallet>(
      'SELECT balance::text AS balance, version FROM wallets WHERE id = $1',
      [walletId],
    );
    return result.rows[0];
  });

const walletCount = (database: TestDatabase): Promise<unknown> =>
  withClient(database.superuserUrl, async (client) => {
    const result = await client.query<{ total: number }>(
      'SELECT count(*)::int AS total FROM wallets',
    );
    return result.rows[0]?.total;
  });

const debit = (wallet: Wallet, transactionId: string, movement: Movement): void => {
  wallet.debit({
    transactionId,
    money: Money.from({ amount: movement.amount, currency: CURRENCY }),
    houseAccountId: movement.gamingId,
    walletEntryId: crypto.randomUUID(),
    houseEntryId: crypto.randomUUID(),
    now: NOW,
  });
};

const recordBet = async (em: EntityManager, wallet: Wallet, movement: Movement): Promise<void> => {
  const transactionId = crypto.randomUUID();
  const balanceBefore = wallet.balance.toJSON().amount;
  debit(wallet, transactionId, movement);
  await em.execute(
    `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
       wallet_id, player_id, round_id, game_id, kind, amount, currency, status, correlation_id, created_at,
       processed_at, updated_at)
     VALUES (?, ?, ?, ?, repeat('a', 64), ?, ?, 'round-1', 'game-1', 'BET', ?, ?, 'PROCESSED',
       'correlation-1', now(), now(), now())`,
    [
      transactionId,
      PROVIDER,
      transactionId,
      transactionId,
      wallet.id,
      wallet.playerId,
      movement.amount,
      CURRENCY,
    ],
  );
  await em.execute(
    `INSERT INTO ledger_entries (id, transaction_id, account_kind, wallet_id, direction, amount, currency,
       balance_before, balance_after, wallet_version, created_at)
     VALUES (?, ?, 'WALLET', ?, 'DEBIT', ?, ?, ?, ?, ?, now())`,
    [
      crypto.randomUUID(),
      transactionId,
      wallet.id,
      movement.amount,
      CURRENCY,
      balanceBefore,
      wallet.balance.toJSON().amount,
      wallet.version,
    ],
  );
  await em.execute(
    `INSERT INTO ledger_entries (id, transaction_id, account_kind, house_account_id, direction, amount, currency,
       created_at)
     VALUES (?, ?, 'HOUSE', ?, 'CREDIT', ?, ?, now())`,
    [crypto.randomUUID(), transactionId, movement.gamingId, movement.amount, CURRENCY],
  );
};

describe('MikroOrmWalletRepository', () => {
  let database: TestDatabase;
  let opened: OrmInstances[] = [];
  let entityManagers = new Map<Repositories, EntityManager>();

  const factory: RepositoriesFactory = (em) => {
    const repos = createRepositories(em);
    entityManagers.set(repos, em);
    return repos;
  };

  const emOf = (repos: Repositories): EntityManager => {
    const em = entityManagers.get(repos);
    if (em === undefined) {
      throw new MissingEntityManagerError();
    }
    return em;
  };

  const openUnitOfWork = async (
    overrides: Record<string, string> = {},
  ): Promise<MikroOrmUnitOfWork> => {
    const config = loadConfig({ DATABASE_URL: database.appUrl, ...overrides }, { role: 'api' });
    const instances = await openOrmInstances(config);
    opened.push(instances);
    return new MikroOrmUnitOfWork(instances, config, factory);
  };

  const holdLock = (
    uow: MikroOrmUnitOfWork,
    walletId: string,
    whileLocked: (repos: Repositories, wallet: Wallet) => Promise<void>,
  ): { locked: Promise<void>; finished: Promise<void> } => {
    const locked: PromiseWithResolvers<void> = Promise.withResolvers();
    const finished = uow.run('write', async (repos) => {
      const held = await repos.wallets.lockById(walletId);
      locked.resolve();
      if (held !== undefined) {
        await whileLocked(repos, held.wallet);
      }
    });
    return { locked: locked.promise, finished };
  };

  beforeEach(async () => {
    database = await createTestDatabase();
  });

  afterEach(async () => {
    await Promise.all(opened.map(closeOrmInstances));
    opened = [];
    entityManagers = new Map();
  });

  describe('lockById', () => {
    it('locks an uncontended wallet and holds the row lock until the transaction ends', async () => {
      const seed = await seedEmptyWallet(database);
      const uow = await openUnitOfWork();
      const outcome = await uow.run('write', async (repos) => {
        const locked = await repos.wallets.lockById(seed.walletId);
        const probe = await failureOf(
          withClient(database.appUrl, (client) =>
            client.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE NOWAIT', [seed.walletId]),
          ),
        );
        return { locked, probe };
      });
      expect(outcome.locked?.contended).toBe(false);
      expect(outcome.locked?.waitSeconds).toBeGreaterThanOrEqual(0);
      expect(outcome.locked?.waitSeconds).toBeLessThan(1);
      expect(outcome.locked?.wallet.toState()).toMatchObject({
        id: seed.walletId,
        playerId: seed.playerId,
        currency: CURRENCY,
        version: 1,
      });
      expect(outcome.locked?.wallet.balance.toJSON()).toEqual({
        amount: '0.00',
        currency: CURRENCY,
      });
      expect(Reflect.get(Object(outcome.probe), 'code')).toBe('55P03');
    });

    it('returns undefined for an unknown wallet', async () => {
      const uow = await openUnitOfWork();
      const locked = await uow.run('write', (repos) => repos.wallets.lockById(crypto.randomUUID()));
      expect(locked).toBeUndefined();
    });

    it('waits for a contended lock, reads the committed state and keeps the transaction usable', async () => {
      const seed = await seedFundedWallet(database);
      const uow = await openUnitOfWork();
      const holder = holdLock(uow, seed.walletId, async (repos, wallet) => {
        await recordBet(emOf(repos), wallet, { amount: '30.00', gamingId: seed.gamingId });
        repos.wallets.update(wallet);
        await repos.flush();
        await Bun.sleep(300);
      });
      await holder.locked;
      const outcome = await uow.run('write', async (repos) => {
        const locked = await repos.wallets.lockById(seed.walletId);
        if (locked === undefined) {
          return undefined;
        }
        await recordBet(emOf(repos), locked.wallet, { amount: '20.00', gamingId: seed.gamingId });
        repos.wallets.update(locked.wallet);
        await repos.flush();
        await repos.wallets.assertPersistedVersion(locked.wallet);
        return {
          contended: locked.contended,
          waitSeconds: locked.waitSeconds,
          finalVersion: locked.wallet.version,
        };
      });
      await holder.finished;
      expect(outcome?.contended).toBe(true);
      expect(outcome?.waitSeconds).toBeGreaterThanOrEqual(0.2);
      expect(outcome?.finalVersion).toBe(3);
      expect(await storedWallet(database, seed.walletId)).toEqual({ balance: '50.00', version: 3 });
    });

    it('fails as a transient lock timeout when the lock outlives lock_timeout', async () => {
      const seed = await seedEmptyWallet(database);
      const uow = await openUnitOfWork({ DB_LOCK_TIMEOUT_MS: '300' });
      const holder = holdLock(uow, seed.walletId, () => Bun.sleep(1200));
      await holder.locked;
      const startedAt = performance.now();
      const failure = await failureOf(
        uow.run('write', (repos) => repos.wallets.lockById(seed.walletId)),
      );
      const elapsedMs = performance.now() - startedAt;
      await holder.finished;
      expectTechnical(failure, ErrorClass.Transient, 'lock_timeout');
      expect(elapsedMs).toBeGreaterThanOrEqual(250);
      expect(elapsedMs).toBeLessThan(1200);
    });

    it('receives NOWAIT contention as a DriverException 55P03 that a savepoint rollback absorbs', async () => {
      const seed = await seedEmptyWallet(database);
      const uow = await openUnitOfWork();
      const release: PromiseWithResolvers<void> = Promise.withResolvers();
      const holder = holdLock(uow, seed.walletId, () => release.promise);
      await holder.locked;
      const outcome = await uow.run('write', async (repos) => {
        const em = emOf(repos);
        await em.execute('SAVEPOINT wallet_lock');
        const nowait = await failureOf(
          em.findOne(WalletRecord, seed.walletId, {
            lockMode: LockMode.PESSIMISTIC_WRITE_OR_FAIL,
            refresh: true,
          }),
        );
        await em.execute('ROLLBACK TO SAVEPOINT wallet_lock');
        const usable = await em.execute('SELECT 1 AS one');
        release.resolve();
        return { nowait, usable };
      });
      await holder.finished;
      expect(outcome.nowait).toBeInstanceOf(DriverException);
      expect(outcome.nowait).not.toBeInstanceOf(LockWaitTimeoutException);
      expect(Reflect.get(Object(outcome.nowait), 'code')).toBe('55P03');
      expect(outcome.usable).toEqual([{ one: 1 }]);
    });
  });

  describe('finders', () => {
    it('finds a wallet by id and by player and currency', async () => {
      const seed = await seedFundedWallet(database);
      const uow = await openUnitOfWork();
      const found = await uow.read(async (repos) => ({
        byId: await repos.wallets.findById(seed.walletId),
        byPlayer: await repos.wallets.findByPlayerAndCurrency(seed.playerId, CURRENCY),
        otherCurrency: await repos.wallets.findByPlayerAndCurrency(seed.playerId, 'USD'),
        unknown: await repos.wallets.findById(crypto.randomUUID()),
      }));
      expect(found.byId?.id).toBe(seed.walletId);
      expect(found.byId?.balance.toJSON()).toEqual({ amount: '100.00', currency: CURRENCY });
      expect(found.byPlayer?.id).toBe(seed.walletId);
      expect(found.otherCurrency).toBeUndefined();
      expect(found.unknown).toBeUndefined();
    });
  });

  describe('insert', () => {
    it('inserts a new wallet whose version comes from the column default', async () => {
      const uow = await openUnitOfWork();
      const created = Wallet.open({
        id: crypto.randomUUID(),
        playerId: crypto.randomUUID(),
        initialBalance: Money.zero(CURRENCY),
        openingTransactionId: crypto.randomUUID(),
        fundingAccountId: crypto.randomUUID(),
        walletEntryId: crypto.randomUUID(),
        houseEntryId: crypto.randomUUID(),
        now: NOW,
      });
      const recordVersion = await uow.run('write', async (repos) => {
        repos.wallets.insert(created.wallet);
        await repos.flush();
        await repos.wallets.assertPersistedVersion(created.wallet);
        const record = await emOf(repos).findOne(WalletRecord, created.wallet.id);
        return record?.version;
      });
      expect(created.posting).toBeUndefined();
      expect(recordVersion).toBe(1);
      expect(await storedWallet(database, created.wallet.id)).toEqual({
        balance: '0.00',
        version: 1,
      });
    });

    it('never writes the version of the record, so a mismatching wallet drifts', async () => {
      const uow = await openUnitOfWork();
      const wallet = Wallet.rehydrate({
        id: crypto.randomUUID(),
        playerId: crypto.randomUUID(),
        currency: toCurrencyCode(CURRENCY),
        balance: Money.zero(CURRENCY),
        version: 7,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const observed: { recordVersion?: number } = {};
      const failure = await failureOf(
        uow.run('write', async (repos) => {
          repos.wallets.insert(wallet);
          await repos.flush();
          const record = await emOf(repos).findOne(WalletRecord, wallet.id);
          if (record !== null) {
            observed.recordVersion = record.version;
          }
          await repos.wallets.assertPersistedVersion(wallet);
        }),
      );
      expect(observed.recordVersion).toBe(1);
      expectTechnical(failure, ErrorClass.Deterministic, 'wallet_version_drift');
      expect(await walletCount(database)).toBe(0);
    });
  });

  describe('update', () => {
    it('increments the version through the ORM and passes the persisted version check', async () => {
      const seed = await seedFundedWallet(database);
      const uow = await openUnitOfWork();
      const versions = await uow.run('write', async (repos) => {
        const locked = await repos.wallets.lockById(seed.walletId);
        if (locked === undefined) {
          return undefined;
        }
        const before = locked.wallet.version;
        await recordBet(emOf(repos), locked.wallet, { amount: '30.00', gamingId: seed.gamingId });
        repos.wallets.update(locked.wallet);
        await repos.flush();
        await repos.wallets.assertPersistedVersion(locked.wallet);
        const record = await emOf(repos).findOne(WalletRecord, seed.walletId);
        return { before, after: locked.wallet.version, record: record?.version };
      });
      expect(versions).toEqual({ before: 1, after: 2, record: 2 });
      expect(await storedWallet(database, seed.walletId)).toEqual({ balance: '70.00', version: 2 });
    });

    it('writes the exact balance of a wallet at the numeric limit for each cent moved', async () => {
      const seed = await seedFundedWallet(database, MAX_BALANCE);
      const uow = await openUnitOfWork();
      const debitLocked = (amount: string) =>
        uow.run('write', async (repos) => {
          const locked = await repos.wallets.lockById(seed.walletId);
          if (locked === undefined) {
            return undefined;
          }
          await recordBet(emOf(repos), locked.wallet, { amount, gamingId: seed.gamingId });
          repos.wallets.update(locked.wallet);
          await repos.flush();
          await repos.wallets.assertPersistedVersion(locked.wallet);
          const record = await emOf(repos).findOne(WalletRecord, seed.walletId);
          return record?.balance;
        });
      expect(await debitLocked('1.00')).toBe('999999999999999998.99');
      expect(await storedWallet(database, seed.walletId)).toEqual({
        balance: '999999999999999998.99',
        version: 2,
      });
      expect(await debitLocked('0.01')).toBe('999999999999999998.98');
      expect(await storedWallet(database, seed.walletId)).toEqual({
        balance: '999999999999999998.98',
        version: 3,
      });
    });

    it('reports a version drift when the update was not flushed', async () => {
      const seed = await seedFundedWallet(database);
      const uow = await openUnitOfWork();
      const failure = await failureOf(
        uow.run('write', async (repos) => {
          const locked = await repos.wallets.lockById(seed.walletId);
          if (locked === undefined) {
            return;
          }
          debit(locked.wallet, crypto.randomUUID(), { amount: '30.00', gamingId: seed.gamingId });
          repos.wallets.update(locked.wallet);
          await repos.wallets.assertPersistedVersion(locked.wallet);
        }),
      );
      expectTechnical(failure, ErrorClass.Deterministic, 'wallet_version_drift');
      expect(await storedWallet(database, seed.walletId)).toEqual({
        balance: '100.00',
        version: 1,
      });
    });

    it('rejects a concurrent update made without the lock as a transient version mismatch', async () => {
      const seed = await seedFundedWallet(database);
      const uow = await openUnitOfWork();
      const failure = await failureOf(
        uow.run('write', async (repos) => {
          const stale = await repos.wallets.findById(seed.walletId);
          if (stale === undefined) {
            return;
          }
          await uow.run('write', async (other) => {
            const locked = await other.wallets.lockById(seed.walletId);
            if (locked === undefined) {
              return;
            }
            await recordBet(emOf(other), locked.wallet, {
              amount: '30.00',
              gamingId: seed.gamingId,
            });
            other.wallets.update(locked.wallet);
          });
          debit(stale, crypto.randomUUID(), { amount: '10.00', gamingId: seed.gamingId });
          repos.wallets.update(stale);
          await repos.flush();
        }),
      );
      expectTechnical(failure, ErrorClass.Transient, 'version_mismatch');
      expect(await storedWallet(database, seed.walletId)).toEqual({ balance: '70.00', version: 2 });
    });
  });
});
