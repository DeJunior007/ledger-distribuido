import { afterEach, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import type { QueryResultRow } from 'pg';
import type { WagerTransactionRequest } from '@interfaces/http/schemas/wager-transaction.schema';
import {
  betCommand,
  createWalletViaUseCase,
  refundCommand,
  submitViaApi,
} from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import { spawnInstances } from '@test/support/spawn-instances';
import type { SpawnedInstances } from '@test/support/spawn-instances';
import { createTestApp } from '@test/support/test-app';
import type { TestApp } from '@test/support/test-app';
import { APP_ROLE, createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

const WAIT = { timeoutMs: 30_000, intervalMs: 100 } as const;
const STALLED_SCHEDULER_ENV = {
  PENDING_LEASE_MS: '2000',
  DB_LOCK_TIMEOUT_MS: '20000',
  DB_STATEMENT_TIMEOUT_MS: '25000',
  DB_TRANSACTION_TIMEOUT_MS: '30000',
  DB_QUERY_TIMEOUT_MS: '30000',
} as const;
const THIEF_INSTANCE_ID = 'scheduler-lease-thief';
const THIEF_LEASE_MS = 600_000;
const PENDING_COUNT = 3;

class MissingRowError extends Error {
  constructor(what: string) {
    super(`${what} was not found`);
    this.name = 'MissingRowError';
  }
}

const required = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) {
    throw new MissingRowError(what);
  }
  return value;
};

interface TransactionRow {
  readonly id: string;
  readonly status: string;
}

interface RetryRow {
  readonly attempts: number;
  readonly consecutive_errors: number;
  readonly locked_by: string | null;
  readonly resolved_at: Date | null;
  readonly lease_expired: boolean;
}

interface PendingRefund {
  readonly wallet: TestWallet;
  readonly bet: WagerTransactionRequest;
  readonly refund: WagerTransactionRequest;
  readonly pendingId: string;
}

const query = async <Row extends QueryResultRow>(
  databaseUrl: string,
  sql: string,
  params: readonly unknown[],
): Promise<Row[]> => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<Row>(sql, [...params]);
    return result.rows;
  } finally {
    await client.end();
  }
};

const transactionByExternalId = async (
  databaseUrl: string,
  externalTransactionId: string,
): Promise<TransactionRow | undefined> => {
  const rows = await query<TransactionRow>(
    databaseUrl,
    `select id, status from wager_transactions
      where provider_id = $1 and external_transaction_id = $2`,
    [TEST_PROVIDER_ID, externalTransactionId],
  );
  return rows[0];
};

const retryOf = async (
  databaseUrl: string,
  transactionId: string,
): Promise<RetryRow | undefined> => {
  const rows = await query<RetryRow>(
    databaseUrl,
    `select attempts, consecutive_errors, locked_by, resolved_at,
        coalesce(locked_until < now(), true) as lease_expired
      from pending_reference_retries where transaction_id = $1`,
    [transactionId],
  );
  return rows[0];
};

const dueOrder = async (databaseUrl: string): Promise<string[]> => {
  const rows = await query<{ transaction_id: string }>(
    databaseUrl,
    `select transaction_id from pending_reference_retries
      where resolved_at is null order by next_attempt_at`,
    [],
  );
  return rows.map((row) => row.transaction_id);
};

const eventTypesOf = async (databaseUrl: string, transactionId: string): Promise<string[]> => {
  const rows = await query<{ event_type: string }>(
    databaseUrl,
    `select event_type from outbox_messages
      where payload->'data'->>'transactionId' = $1
      order by event_type`,
    [transactionId],
  );
  return rows.map((row) => row.event_type);
};

const ledgerEntryCount = async (databaseUrl: string, transactionId: string): Promise<number> => {
  const rows = await query<{ entries: number }>(
    databaseUrl,
    'select count(*)::int as entries from ledger_entries where transaction_id = $1',
    [transactionId],
  );
  return rows[0]?.entries ?? 0;
};

const walletBalance = async (
  databaseUrl: string,
  walletId: string,
): Promise<string | undefined> => {
  const rows = await query<{ balance: string }>(
    databaseUrl,
    'select balance::text as balance from wallets where id = $1',
    [walletId],
  );
  return rows[0]?.balance;
};

const lockWaiters = async (databaseUrl: string): Promise<number> => {
  const rows = await query<{ waiting: number }>(
    databaseUrl,
    `select count(*)::int as waiting from pg_stat_activity
      where datname = current_database() and usename = $1 and wait_event_type = 'Lock'`,
    [APP_ROLE],
  );
  return rows[0]?.waiting ?? 0;
};

const stealLease = async (databaseUrl: string, transactionId: string): Promise<number> => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(
      `update pending_reference_retries
        set locked_until = now() + ($1 * interval '1 millisecond'), locked_by = $2
        where transaction_id = $3 and resolved_at is null
          and (locked_until is null or locked_until < now())`,
      [THIEF_LEASE_MS, THIEF_INSTANCE_ID, transactionId],
    );
    return result.rowCount ?? 0;
  } finally {
    await client.end();
  }
};

const releaseLeases = async (databaseUrl: string): Promise<void> => {
  await query(
    databaseUrl,
    `update pending_reference_retries set locked_until = null, locked_by = null
      where resolved_at is null`,
    [],
  );
};

class WalletLock {
  private constructor(
    private readonly client: Client,
    private held: boolean,
  ) {}

  static async acquire(databaseUrl: string, walletId: string): Promise<WalletLock> {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query('begin');
    await client.query('select id from wallets where id = $1 for update', [walletId]);
    return new WalletLock(client, true);
  }

  async release(): Promise<void> {
    if (!this.held) {
      return;
    }
    this.held = false;
    try {
      await this.client.query('commit');
    } finally {
      await this.client.end();
    }
  }
}

const providerTokenOf = (api: TestApp): Promise<string> =>
  api.issuer.token({ role: 'provider', providerId: TEST_PROVIDER_ID });

const pendingRefundWithProcessedBet = async (
  database: TestDatabase,
  api: TestApp,
): Promise<PendingRefund> => {
  const providerToken = await providerTokenOf(api);
  const wallet = await createWalletViaUseCase(api);
  const roundId = `round-${crypto.randomUUID()}`;
  const bet = betCommand({ wallet, roundId });
  const refund = refundCommand({
    wallet,
    roundId,
    referenceExternalTransactionId: bet.body.externalTransactionId,
  });
  const accepted = await submitViaApi(api.baseUrl, providerToken, refund);
  expect(accepted.status).toBe(202);
  const pending = required(
    await transactionByExternalId(database.superuserUrl, refund.body.externalTransactionId),
    'pending refund',
  );
  return { wallet, bet, refund, pendingId: pending.id };
};

const placeBet = async (api: TestApp, pending: PendingRefund): Promise<void> => {
  const placed = await submitViaApi(api.baseUrl, await providerTokenOf(api), pending.bet);
  expect(placed.status).toBe(200);
};

const statusOf = async (database: TestDatabase, pending: PendingRefund): Promise<string> =>
  (await transactionByExternalId(database.superuserUrl, pending.refund.body.externalTransactionId))
    ?.status ?? 'MISSING';

describe('pending reference leases', () => {
  let database: TestDatabase | undefined;

  afterEach(async () => {
    if (database !== undefined) {
      await releaseLeases(database.superuserUrl);
    }
    database = undefined;
  });

  it('applies the pending reference once when its lease expires mid-resolution', async () => {
    const current = await createTestDatabase();
    database = current;
    const queues = await createTestQueues();
    const api = await createTestApp({
      roles: ['api'],
      env: { DATABASE_URL: current.appUrl, ...queues.env },
    });
    let lock: WalletLock | undefined;
    let schedulers: SpawnedInstances | undefined;
    try {
      const pending = await pendingRefundWithProcessedBet(current, api);
      await placeBet(api, pending);
      lock = await WalletLock.acquire(current.superuserUrl, pending.wallet.id);

      schedulers = await spawnInstances({
        role: 'scheduler',
        count: 2,
        env: { DATABASE_URL: current.appUrl, ...queues.env, ...STALLED_SCHEDULER_ENV },
      });
      const instanceIds = schedulers.instances.map((instance) => instance.instanceId);

      let firstHolder: string | undefined;
      await waitFor(async () => {
        firstHolder =
          (await retryOf(current.superuserUrl, pending.pendingId))?.locked_by ?? undefined;
        return firstHolder !== undefined && (await lockWaiters(current.superuserUrl)) === 1;
      }, WAIT);
      let secondHolder: string | undefined;
      await waitFor(async () => {
        secondHolder =
          (await retryOf(current.superuserUrl, pending.pendingId))?.locked_by ?? undefined;
        return (
          secondHolder !== undefined &&
          secondHolder !== firstHolder &&
          (await lockWaiters(current.superuserUrl)) === 2
        );
      }, WAIT);
      expect(instanceIds).toContain(required(firstHolder, 'first lease holder'));
      expect(instanceIds).toContain(required(secondHolder, 'second lease holder'));
      expect(await statusOf(current, pending)).toBe('PENDING_REFERENCE');

      await lock.release();
      await waitFor(
        async () =>
          (await statusOf(current, pending)) === 'PROCESSED' &&
          (await lockWaiters(current.superuserUrl)) === 0,
        WAIT,
      );
      await schedulers.stop();
      schedulers = undefined;

      const placedBet = required(
        await transactionByExternalId(current.superuserUrl, pending.bet.body.externalTransactionId),
        'placed bet',
      );
      const betEntries = await ledgerEntryCount(current.superuserUrl, placedBet.id);
      expect(betEntries).toBeGreaterThan(0);
      expect(await ledgerEntryCount(current.superuserUrl, pending.pendingId)).toBe(betEntries);
      expect(await eventTypesOf(current.superuserUrl, pending.pendingId)).toEqual([
        'WagerTransactionPendingReference',
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
      expect(await walletBalance(current.superuserUrl, pending.wallet.id)).toBe('1000.00');
      const retry = required(await retryOf(current.superuserUrl, pending.pendingId), 'retry');
      expect(retry.resolved_at).toBeInstanceOf(Date);
      expect(retry.locked_by).toBeNull();
    } finally {
      await lock?.release();
      await schedulers?.stop();
      await api.stop();
    }
  });

  it('skips an item whose lease was taken over before its renewal', async () => {
    const current = await createTestDatabase();
    database = current;
    const queues = await createTestQueues();
    const api = await createTestApp({
      roles: ['api'],
      env: { DATABASE_URL: current.appUrl, ...queues.env },
    });
    let lock: WalletLock | undefined;
    let scheduler: TestApp | undefined;
    try {
      const created: PendingRefund[] = [];
      for (let index = 0; index < PENDING_COUNT; index += 1) {
        created.push(await pendingRefundWithProcessedBet(current, api));
      }
      for (const pending of created) {
        await placeBet(api, pending);
      }
      const byId = new Map(created.map((pending) => [pending.pendingId, pending]));
      const [blocked, stolen, marker] = (await dueOrder(current.superuserUrl)).map((id) =>
        required(byId.get(id), id),
      );
      const blockedRefund = required(blocked, 'blocked refund');
      const stolenRefund = required(stolen, 'stolen refund');
      const markerRefund = required(marker, 'marker refund');
      lock = await WalletLock.acquire(current.superuserUrl, blockedRefund.wallet.id);

      scheduler = await createTestApp({
        roles: ['scheduler'],
        env: { DATABASE_URL: current.appUrl, ...queues.env, ...STALLED_SCHEDULER_ENV },
      });
      const schedulerId = scheduler.config.INSTANCE_ID;
      await waitFor(async () => (await lockWaiters(current.superuserUrl)) === 1, WAIT);
      await waitFor(async () => {
        const retry = await retryOf(current.superuserUrl, stolenRefund.pendingId);
        return retry?.locked_by === schedulerId && retry.lease_expired;
      }, WAIT);
      expect((await retryOf(current.superuserUrl, markerRefund.pendingId))?.locked_by).toBe(
        schedulerId,
      );

      expect(await stealLease(current.appUrl, stolenRefund.pendingId)).toBe(1);
      await lock.release();
      await waitFor(async () => (await statusOf(current, markerRefund)) === 'PROCESSED', WAIT);
      await scheduler.stop();
      scheduler = undefined;

      expect(await statusOf(current, blockedRefund)).toBe('PROCESSED');
      expect(await statusOf(current, stolenRefund)).toBe('PENDING_REFERENCE');
      expect(await retryOf(current.superuserUrl, stolenRefund.pendingId)).toMatchObject({
        attempts: 0,
        consecutive_errors: 0,
        locked_by: THIEF_INSTANCE_ID,
        resolved_at: null,
        lease_expired: false,
      });
      expect(await ledgerEntryCount(current.superuserUrl, stolenRefund.pendingId)).toBe(0);
      expect(await eventTypesOf(current.superuserUrl, stolenRefund.pendingId)).toEqual([
        'WagerTransactionPendingReference',
      ]);
      expect(await walletBalance(current.superuserUrl, stolenRefund.wallet.id)).toBe('990.00');
    } finally {
      await lock?.release();
      await scheduler?.stop();
      await api.stop();
    }
  });
});
