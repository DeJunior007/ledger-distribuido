import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import type { PendingReferenceRetry } from '@application/ports/repositories/pending-reference-repository.port';
import { loadConfig } from '@infrastructure/config/env.schema';
import { MikroOrmUnitOfWork } from '@infrastructure/persistence/mikro-orm-unit-of-work';
import { closeOrmInstances, openOrmInstances } from '@infrastructure/persistence/orm-instances';
import type { OrmInstances } from '@infrastructure/persistence/orm-instances';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';

const WALLET_ID = '0198c000-0000-7000-8000-000000000001';
const PLAYER_ID = '0198c000-0000-7000-8000-000000000002';
const PAST = new Date('2020-01-01T00:00:00.000Z');
const FUTURE = new Date('2100-01-01T00:00:00.000Z');
const DEADLINE = new Date('2100-01-01T00:15:00.000Z');
const LEASE_MS = 30_000;
const HASH = 'a'.repeat(64);

const INSERT_WALLET = `INSERT INTO wallets (id, player_id, currency, balance, created_at, updated_at)
VALUES ($1, $2, 'BRL', 0, now(), now())`;

const INSERT_TRANSACTION = `INSERT INTO wager_transactions (
  id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
  round_id, game_id, kind, amount, currency, reference_external_transaction_id,
  status, failure_code, correlation_id, created_at, updated_at
) VALUES ($1, $2, $3, $3, $4, $5, $6, 'round-1', 'game-1', 'WIN', 10, 'BRL', $7, $8, $9, 'corr-1', now(), now())`;

interface TransactionOptions {
  readonly providerId?: string;
  readonly reference?: string;
  readonly status?: 'PENDING_REFERENCE' | 'REJECTED';
}

interface SeededTransaction extends TransactionOptions {
  readonly index: number;
}

interface StoredRetryRow {
  readonly attempts: number;
  readonly consecutive_errors: number;
  readonly next_attempt_at: Date;
  readonly locked_until: Date | null;
  readonly locked_by: string | null;
  readonly resolved_at: Date | null;
}

const transactionId = (index: number): string =>
  `0198c000-0000-7000-8000-${String(index + 100).padStart(12, '0')}`;

const minutesAfter = (base: Date, minutes: number): Date =>
  new Date(base.getTime() + minutes * 60_000);

const retryFor = (
  index: number,
  overrides: Partial<PendingReferenceRetry> = {},
): PendingReferenceRetry => ({
  transactionId: transactionId(index),
  attempts: 0,
  consecutiveErrors: 0,
  nextAttemptAt: PAST,
  deadlineAt: DEADLINE,
  lockedUntil: undefined,
  lockedBy: undefined,
  resolvedAt: undefined,
  createdAt: PAST,
  ...overrides,
});

const idsOf = (retries: readonly PendingReferenceRetry[]): string[] =>
  retries.map((retry) => retry.transactionId);

describe('MikroOrmPendingReferenceRepository', () => {
  let database: TestDatabase;
  let instances: OrmInstances;
  let uow: MikroOrmUnitOfWork;
  let client: Client;

  const insertTransaction = async (id: string, options: TransactionOptions): Promise<void> => {
    const status = options.status ?? 'PENDING_REFERENCE';
    await client.query(INSERT_TRANSACTION, [
      id,
      options.providerId ?? 'provider-a',
      `win-${id}`,
      HASH,
      WALLET_ID,
      PLAYER_ID,
      options.reference ?? 'bet-1',
      status,
      status === 'REJECTED' ? 'REFERENCE_NOT_FOUND' : null,
    ]);
  };

  const seedTransactions = async (...transactions: SeededTransaction[]): Promise<void> => {
    for (const transaction of transactions) {
      await insertTransaction(transactionId(transaction.index), transaction);
    }
  };

  const insertRetries = (...retries: PendingReferenceRetry[]): Promise<void> =>
    uow.run('short', async (repos) => {
      for (const retry of retries) {
        repos.pendingReferences.insert(retry);
      }
      await repos.flush();
    });

  const seed = async (...retries: PendingReferenceRetry[]): Promise<void> => {
    for (const retry of retries) {
      await insertTransaction(retry.transactionId, {});
    }
    await insertRetries(...retries);
  };

  const claim = (instanceId: string, limit: number): Promise<PendingReferenceRetry[]> =>
    uow.run('short', (repos) =>
      repos.pendingReferences.claimDue({ instanceId, leaseMs: LEASE_MS, limit }),
    );

  const stored = async (index: number): Promise<StoredRetryRow | undefined> => {
    const result = await client.query<StoredRetryRow>(
      `SELECT attempts, consecutive_errors, next_attempt_at, locked_until, locked_by, resolved_at
       FROM pending_reference_retries WHERE transaction_id = $1`,
      [transactionId(index)],
    );
    return result.rows[0];
  };

  const databaseNow = async (): Promise<Date> => {
    const result = await client.query<{ now: Date }>('SELECT now() AS now');
    return result.rows[0]?.now ?? PAST;
  };

  beforeEach(async () => {
    database = await createTestDatabase();
    const config = loadConfig({ DATABASE_URL: database.appUrl }, { role: 'api' });
    instances = await openOrmInstances(config);
    uow = new MikroOrmUnitOfWork(instances, config);
    client = new Client({ connectionString: database.appUrl });
    await client.connect();
    await client.query(INSERT_WALLET, [WALLET_ID, PLAYER_ID]);
  });

  afterEach(async () => {
    await client.query(
      'UPDATE pending_reference_retries SET locked_until = NULL, locked_by = NULL WHERE locked_until IS NOT NULL',
    );
    await client.end();
    await closeOrmInstances(instances);
  });

  describe('insert', () => {
    it('persists the retry with every field on flush', async () => {
      await seed(retryFor(1, { attempts: 2, consecutiveErrors: 1, nextAttemptAt: FUTURE }));
      const result = await client.query<Record<string, unknown>>(
        'SELECT * FROM pending_reference_retries WHERE transaction_id = $1',
        [transactionId(1)],
      );
      expect(result.rows[0]).toEqual({
        transaction_id: transactionId(1),
        attempts: 2,
        consecutive_errors: 1,
        next_attempt_at: FUTURE,
        deadline_at: DEADLINE,
        locked_until: null,
        locked_by: null,
        resolved_at: null,
        created_at: PAST,
      });
    });
  });

  describe('claimDue', () => {
    it('leases only due, open and unleased retries in next attempt order', async () => {
      await seed(
        retryFor(1, { nextAttemptAt: minutesAfter(PAST, 3) }),
        retryFor(2, { nextAttemptAt: minutesAfter(PAST, 1) }),
        retryFor(3, { nextAttemptAt: FUTURE }),
        retryFor(4, { resolvedAt: PAST }),
        retryFor(5, { lockedUntil: FUTURE, lockedBy: 'instance-z' }),
        retryFor(6, { nextAttemptAt: minutesAfter(PAST, 2) }),
      );
      const before = await databaseNow();
      const claimed = await claim('instance-a', 10);
      expect(idsOf(claimed)).toEqual([transactionId(2), transactionId(6), transactionId(1)]);
      expect(claimed[0]).toMatchObject({
        transactionId: transactionId(2),
        attempts: 0,
        consecutiveErrors: 0,
        deadlineAt: DEADLINE,
        lockedBy: 'instance-a',
        resolvedAt: undefined,
        createdAt: PAST,
      });
      expect(claimed[0]?.lockedUntil?.getTime()).toBeGreaterThanOrEqual(
        before.getTime() + LEASE_MS,
      );
      expect((await stored(5))?.locked_by).toBe('instance-z');
      expect((await stored(3))?.locked_by).toBeNull();
    });

    it('respects the limit and skips rows another open claim holds', async () => {
      await seed(retryFor(1), retryFor(2), retryFor(3), retryFor(4));
      const firstClaimed: PromiseWithResolvers<string[]> = Promise.withResolvers();
      const release: PromiseWithResolvers<void> = Promise.withResolvers();
      const first = uow.run('short', async (repos) => {
        const claimed = await repos.pendingReferences.claimDue({
          instanceId: 'instance-a',
          leaseMs: LEASE_MS,
          limit: 2,
        });
        firstClaimed.resolve(idsOf(claimed));
        await release.promise;
      });
      const heldByFirst = await firstClaimed.promise;
      const second = await claim('instance-b', 10);
      release.resolve();
      await first;
      expect(heldByFirst).toHaveLength(2);
      expect(second).toHaveLength(2);
      expect(idsOf(second).filter((id) => heldByFirst.includes(id))).toEqual([]);
    });

    it('never hands the same retry to concurrent claims', async () => {
      await seed(...Array.from({ length: 20 }, (_, index) => retryFor(index + 1)));
      const batches = await Promise.all(
        ['instance-a', 'instance-b', 'instance-c', 'instance-d', 'instance-e'].map((instance) =>
          claim(instance, 6),
        ),
      );
      const claimedIds = batches.flatMap(idsOf);
      expect(new Set(claimedIds).size).toBe(claimedIds.length);
    });
  });

  describe('renewLease', () => {
    it('extends the lease only for the instance that holds it', async () => {
      await seed(retryFor(1));
      await claim('instance-a', 10);
      const leasedUntil = (await stored(1))?.locked_until?.getTime() ?? 0;
      const stolen = await uow.run('short', (repos) =>
        repos.pendingReferences.renewLease(transactionId(1), 'instance-b', 120_000),
      );
      expect(stolen).toBe(false);
      expect((await stored(1))?.locked_until?.getTime()).toBe(leasedUntil);
      const owned = await uow.run('short', (repos) =>
        repos.pendingReferences.renewLease(transactionId(1), 'instance-a', 120_000),
      );
      expect(owned).toBe(true);
      expect((await stored(1))?.locked_until?.getTime()).toBeGreaterThan(leasedUntil);
    });

    it('returns false for a resolved retry', async () => {
      await seed(retryFor(1, { lockedBy: 'instance-a', lockedUntil: FUTURE, resolvedAt: PAST }));
      const renewed = await uow.run('short', (repos) =>
        repos.pendingReferences.renewLease(transactionId(1), 'instance-a', LEASE_MS),
      );
      expect(renewed).toBe(false);
    });
  });

  describe('scheduleNext', () => {
    it('schedules the next attempt only for the instance that holds the lease', async () => {
      await seed(retryFor(1));
      await claim('instance-a', 10);
      const next = {
        transactionId: transactionId(1),
        nextAttemptAt: FUTURE,
        attempts: 3,
        consecutiveErrors: 2,
      };
      const stolen = await uow.run('short', (repos) =>
        repos.pendingReferences.scheduleNext({ ...next, instanceId: 'instance-b' }),
      );
      expect(stolen).toBe(false);
      expect((await stored(1))?.attempts).toBe(0);
      const owned = await uow.run('short', (repos) =>
        repos.pendingReferences.scheduleNext({ ...next, instanceId: 'instance-a' }),
      );
      expect(owned).toBe(true);
      expect(await stored(1)).toMatchObject({
        attempts: 3,
        consecutive_errors: 2,
        next_attempt_at: FUTURE,
        locked_until: null,
        locked_by: null,
        resolved_at: null,
      });
    });
  });

  describe('markResolved', () => {
    it('resolves an open retry once and clears its lease', async () => {
      await seed(retryFor(1));
      await claim('instance-a', 10);
      const resolvedAt = new Date('2026-10-24T12:00:00.000Z');
      await uow.run('short', (repos) =>
        repos.pendingReferences.markResolved(transactionId(1), resolvedAt),
      );
      expect(await stored(1)).toMatchObject({
        resolved_at: resolvedAt,
        locked_until: null,
        locked_by: null,
      });
      await uow.run('short', (repos) =>
        repos.pendingReferences.markResolved(transactionId(1), FUTURE),
      );
      expect((await stored(1))?.resolved_at).toEqual(resolvedAt);
    });
  });

  describe('wakeDependents', () => {
    it('makes due only the open retries waiting on that provider and reference', async () => {
      await seedTransactions(
        { index: 1 },
        { index: 2 },
        { index: 3, providerId: 'provider-b' },
        { index: 4, reference: 'bet-2' },
        { index: 5 },
        { index: 6 },
        { index: 7, status: 'REJECTED' },
      );
      await insertRetries(
        retryFor(1, { nextAttemptAt: FUTURE }),
        retryFor(2, { nextAttemptAt: FUTURE }),
        retryFor(3, { nextAttemptAt: FUTURE }),
        retryFor(4, { nextAttemptAt: FUTURE }),
        retryFor(5, { nextAttemptAt: FUTURE, resolvedAt: PAST }),
        retryFor(6, { nextAttemptAt: PAST }),
        retryFor(7, { nextAttemptAt: FUTURE }),
      );
      const woken = await uow.run('short', (repos) =>
        repos.pendingReferences.wakeDependents('provider-a', 'bet-1'),
      );
      expect(woken).toBe(2);
      const now = await databaseNow();
      expect((await stored(1))?.next_attempt_at.getTime()).toBeLessThanOrEqual(now.getTime());
      expect((await stored(2))?.next_attempt_at.getTime()).toBeLessThanOrEqual(now.getTime());
      for (const untouched of [3, 4, 5, 7]) {
        expect((await stored(untouched))?.next_attempt_at).toEqual(FUTURE);
      }
      expect((await stored(6))?.next_attempt_at).toEqual(PAST);
    });
  });

  describe('openCount', () => {
    it('counts the unresolved retries as a number', async () => {
      expect(await uow.run('short', (repos) => repos.pendingReferences.openCount())).toBe(0);
      await seed(
        retryFor(1),
        retryFor(2, { nextAttemptAt: FUTURE }),
        retryFor(3, { resolvedAt: PAST }),
      );
      const open = await uow.run('short', (repos) => repos.pendingReferences.openCount());
      expect(open).toBe(2);
    });
  });
});
