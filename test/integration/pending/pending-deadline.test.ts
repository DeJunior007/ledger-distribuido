import { afterEach, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import type { QueryResultRow } from 'pg';
import {
  betCommand,
  createWalletViaUseCase,
  refundCommand,
  rollbackCommand,
  submitViaApi,
  winCommand,
} from '@test/support/fixtures';
import { createTestApp } from '@test/support/test-app';
import type { TestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

const WAIT = { timeoutMs: 20_000, intervalMs: 100 } as const;
const SHORT_TTL_MS = '3000';
const LONG_TTL_MS = '600000';
const WIN_AMOUNT = '25.00';

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
  readonly failure_code: string | null;
  readonly reference_transaction_id: string | null;
}

interface RetryRow {
  readonly attempts: number;
  readonly deadline_at: Date;
  readonly resolved_at: Date | null;
  readonly expired: boolean;
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
    `select id, status, failure_code, reference_transaction_id from wager_transactions
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
    `select attempts, deadline_at, resolved_at, now() >= deadline_at as expired
      from pending_reference_retries where transaction_id = $1`,
    [transactionId],
  );
  return rows[0];
};

const eventTypesOf = async (databaseUrl: string, transactionId: string): Promise<string[]> => {
  const rows = await query<{ event_type: string }>(
    databaseUrl,
    `select event_type from outbox_messages
      where payload->'data'->>'transactionId' = $1
      order by occurred_at, event_type`,
    [transactionId],
  );
  return rows.map((row) => row.event_type);
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

const releaseLeases = async (databaseUrl: string): Promise<void> => {
  await query(
    databaseUrl,
    `update pending_reference_retries set locked_until = null, locked_by = null
      where resolved_at is null`,
    [],
  );
};

const providerTokenOf = (app: TestApp): Promise<string> =>
  app.issuer.token({ role: 'provider', providerId: TEST_PROVIDER_ID });

const waitForStatus = async (
  databaseUrl: string,
  externalTransactionId: string,
  status: string,
): Promise<TransactionRow> => {
  let found: TransactionRow | undefined;
  await waitFor(async () => {
    found = await transactionByExternalId(databaseUrl, externalTransactionId);
    return found?.status === status;
  }, WAIT);
  return required(found, externalTransactionId);
};

describe('pending reference deadline', () => {
  let database: TestDatabase | undefined;

  afterEach(async () => {
    if (database !== undefined) {
      await releaseLeases(database.superuserUrl);
    }
    database = undefined;
  });

  it('rejects with REFERENCE_NOT_FOUND when the deadline passes without the reference', async () => {
    const current = await createTestDatabase();
    database = current;
    const app = await createTestApp({
      roles: ['api', 'scheduler'],
      env: { DATABASE_URL: current.appUrl, PENDING_TTL_MS: SHORT_TTL_MS },
    });
    try {
      const providerToken = await providerTokenOf(app);
      const wallet = await createWalletViaUseCase(app);
      const refund = refundCommand({
        wallet,
        referenceExternalTransactionId: `ext-missing-${crypto.randomUUID()}`,
      });

      const accepted = await submitViaApi(app.baseUrl, providerToken, refund);
      expect(accepted.status).toBe(202);
      const pending = required(
        await transactionByExternalId(current.superuserUrl, refund.body.externalTransactionId),
        'pending refund',
      );

      const rejected = await waitForStatus(
        current.superuserUrl,
        refund.body.externalTransactionId,
        'REJECTED',
      );
      expect(rejected.failure_code).toBe('REFERENCE_NOT_FOUND');
      const retry = required(await retryOf(current.superuserUrl, pending.id), 'refund retry');
      expect(retry.attempts).toBeGreaterThan(0);
      expect(retry.resolved_at?.getTime()).toBeGreaterThanOrEqual(retry.deadline_at.getTime());
      expect(await walletBalance(current.superuserUrl, wallet.id)).toBe('1000.00');
      expect(await eventTypesOf(current.superuserUrl, pending.id)).toEqual([
        'WagerTransactionPendingReference',
        'WagerTransactionRejected',
      ]);

      const replay = await submitViaApi(app.baseUrl, providerToken, refund);
      expect(replay.status).toBe(422);
      const replayBody: unknown = await replay.json();
      expect(replayBody).toMatchObject({
        transactionId: pending.id,
        status: 'REJECTED',
        failureCode: 'REFERENCE_NOT_FOUND',
        idempotentReplay: true,
      });
    } finally {
      await app.stop();
    }
  });

  it('rejects with REFERENCE_NOT_PROCESSED when the reference is still pending at the deadline', async () => {
    const current = await createTestDatabase();
    database = current;
    const queues = await createTestQueues();
    const patient = await createTestApp({
      roles: ['api'],
      env: { DATABASE_URL: current.appUrl, PENDING_TTL_MS: LONG_TTL_MS, ...queues.env },
    });
    const hasty = await createTestApp({
      roles: ['api', 'scheduler'],
      env: { DATABASE_URL: current.appUrl, PENDING_TTL_MS: SHORT_TTL_MS, ...queues.env },
    });
    try {
      const wallet = await createWalletViaUseCase(hasty);
      const roundId = `round-${crypto.randomUUID()}`;
      const win = winCommand({
        wallet,
        roundId,
        amount: WIN_AMOUNT,
        referenceExternalTransactionId: `ext-missing-${crypto.randomUUID()}`,
      });
      const rollback = rollbackCommand({
        wallet,
        roundId,
        amount: WIN_AMOUNT,
        referenceExternalTransactionId: win.body.externalTransactionId,
      });

      const winAccepted = await submitViaApi(patient.baseUrl, await providerTokenOf(patient), win);
      expect(winAccepted.status).toBe(202);
      const rollbackAccepted = await submitViaApi(
        hasty.baseUrl,
        await providerTokenOf(hasty),
        rollback,
      );
      expect(rollbackAccepted.status).toBe(202);

      const rejected = await waitForStatus(
        current.superuserUrl,
        rollback.body.externalTransactionId,
        'REJECTED',
      );
      expect(rejected.failure_code).toBe('REFERENCE_NOT_PROCESSED');
      const pendingWin = required(
        await transactionByExternalId(current.superuserUrl, win.body.externalTransactionId),
        'pending win',
      );
      expect(pendingWin.status).toBe('PENDING_REFERENCE');
      const winRetry = required(await retryOf(current.superuserUrl, pendingWin.id), 'win retry');
      expect(winRetry.resolved_at).toBeNull();
      expect(winRetry.expired).toBe(false);
      const rollbackRetry = required(
        await retryOf(current.superuserUrl, rejected.id),
        'rollback retry',
      );
      expect(rollbackRetry.resolved_at?.getTime()).toBeGreaterThanOrEqual(
        rollbackRetry.deadline_at.getTime(),
      );
      expect(await walletBalance(current.superuserUrl, wallet.id)).toBe('1000.00');
      expect(await eventTypesOf(current.superuserUrl, rejected.id)).toEqual([
        'WagerTransactionPendingReference',
        'WagerTransactionRejected',
      ]);
    } finally {
      await hasty.stop();
      await patient.stop();
    }
  });

  it('applies on the last attempt a reference that arrived while the worker was down', async () => {
    const current = await createTestDatabase();
    database = current;
    const queues = await createTestQueues();
    const env = { DATABASE_URL: current.appUrl, PENDING_TTL_MS: SHORT_TTL_MS, ...queues.env };
    const api = await createTestApp({ roles: ['api'], env });
    let scheduler: TestApp | undefined;
    try {
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
        await transactionByExternalId(current.superuserUrl, refund.body.externalTransactionId),
        'pending refund',
      );
      await waitFor(
        async () => (await retryOf(current.superuserUrl, pending.id))?.expired === true,
        WAIT,
      );

      const placed = await submitViaApi(api.baseUrl, providerToken, bet);
      expect(placed.status).toBe(200);
      const placedBet = required(
        await transactionByExternalId(current.superuserUrl, bet.body.externalTransactionId),
        'placed bet',
      );
      const untouched = required(await retryOf(current.superuserUrl, pending.id), 'refund retry');
      expect(untouched).toMatchObject({ attempts: 0, resolved_at: null, expired: true });
      expect(
        (await transactionByExternalId(current.superuserUrl, refund.body.externalTransactionId))
          ?.status,
      ).toBe('PENDING_REFERENCE');

      scheduler = await createTestApp({ roles: ['scheduler'], env });
      const applied = await waitForStatus(
        current.superuserUrl,
        refund.body.externalTransactionId,
        'PROCESSED',
      );
      expect(applied).toMatchObject({ failure_code: null, reference_transaction_id: placedBet.id });
      const retry = required(await retryOf(current.superuserUrl, pending.id), 'refund retry');
      expect(retry.attempts).toBe(0);
      expect(retry.resolved_at?.getTime()).toBeGreaterThanOrEqual(retry.deadline_at.getTime());
      expect(await walletBalance(current.superuserUrl, wallet.id)).toBe('1000.00');

      const replay = await submitViaApi(api.baseUrl, providerToken, refund);
      expect(replay.status).toBe(200);
      const replayBody: unknown = await replay.json();
      expect(replayBody).toMatchObject({
        transactionId: pending.id,
        status: 'PROCESSED',
        idempotentReplay: true,
      });
    } finally {
      await scheduler?.stop();
      await api.stop();
    }
  });
});
