import { afterEach, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import type { QueryResultRow } from 'pg';
import {
  breakLedgerWrites,
  breakOutboxWrites,
  restoreGrants,
} from '@test/support/deterministic-failure';
import {
  betCommand,
  createWalletViaUseCase,
  refundCommand,
  submitViaApi,
} from '@test/support/fixtures';
import type { WagerTransactionRequest } from '@interfaces/http/schemas/wager-transaction.schema';
import { createTestApp } from '@test/support/test-app';
import type { TestApp } from '@test/support/test-app';
import { APP_ROLE, createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

const WAIT = { timeoutMs: 45_000, intervalMs: 200 } as const;
const MAX_DETERMINISTIC_ERRORS = '2';
const FAILED_PATH_METRIC = 'jungle_pending_reference_failed_path_errors_total';

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
}

interface RetryRow {
  readonly consecutive_errors: number;
  readonly resolved_at: Date | null;
}

interface PendingRefund {
  readonly api: TestApp;
  readonly providerToken: string;
  readonly refund: WagerTransactionRequest;
  readonly pendingId: string;
  readonly walletId: string;
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
    `select id, status, failure_code from wager_transactions
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
    `select consecutive_errors, resolved_at from pending_reference_retries
      where transaction_id = $1`,
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

const storedHttpStatus = async (
  databaseUrl: string,
  idempotencyKey: string,
): Promise<number | undefined> => {
  const rows = await query<{ http_status: number }>(
    databaseUrl,
    'select http_status from idempotency_records where provider_id = $1 and idempotency_key = $2',
    [TEST_PROVIDER_ID, idempotencyKey],
  );
  return rows[0]?.http_status;
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

const appCanInsert = async (databaseUrl: string): Promise<boolean> => {
  const rows = await query<{ allowed: boolean }>(
    databaseUrl,
    `select has_table_privilege($1, 'ledger_entries', 'INSERT')
        and has_table_privilege($1, 'outbox_messages', 'INSERT') as allowed`,
    [APP_ROLE],
  );
  return rows[0]?.allowed === true;
};

const releaseLeases = async (databaseUrl: string): Promise<void> => {
  await query(
    databaseUrl,
    `update pending_reference_retries set locked_until = null, locked_by = null
      where resolved_at is null`,
    [],
  );
};

const failedPathErrors = async (api: TestApp): Promise<number> => {
  const response = await fetch(`${api.baseUrl}/metrics`);
  const text = await response.text();
  const line = text.split('\n').find((candidate) => candidate.startsWith(`${FAILED_PATH_METRIC} `));
  return Number(line?.split(' ')[1] ?? '0');
};

const pendingRefundWithProcessedBet = async (
  database: TestDatabase,
  api: TestApp,
): Promise<PendingRefund> => {
  const providerToken = await api.issuer.token({ role: 'provider', providerId: TEST_PROVIDER_ID });
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
  const placed = await submitViaApi(api.baseUrl, providerToken, bet);
  expect(placed.status).toBe(200);
  const pending = required(
    await transactionByExternalId(database.superuserUrl, refund.body.externalTransactionId),
    'pending refund',
  );
  expect(pending.status).toBe('PENDING_REFERENCE');
  return { api, providerToken, refund, pendingId: pending.id, walletId: wallet.id };
};

describe('pending reference failure path', () => {
  let database: TestDatabase | undefined;

  afterEach(async () => {
    if (database !== undefined) {
      await restoreGrants(database);
      expect(await appCanInsert(database.superuserUrl)).toBe(true);
      await releaseLeases(database.superuserUrl);
    }
    database = undefined;
  });

  it('fails the pending reference after repeated deterministic errors', async () => {
    const current = await createTestDatabase();
    database = current;
    const queues = await createTestQueues();
    const env = {
      DATABASE_URL: current.appUrl,
      PENDING_MAX_DETERMINISTIC_ERRORS: MAX_DETERMINISTIC_ERRORS,
      ...queues.env,
    };
    const api = await createTestApp({ roles: ['api'], env });
    let scheduler: TestApp | undefined;
    try {
      const pending = await pendingRefundWithProcessedBet(current, api);
      await breakLedgerWrites(current);

      scheduler = await createTestApp({ roles: ['scheduler'], env });
      let failed: TransactionRow | undefined;
      await waitFor(async () => {
        failed = await transactionByExternalId(
          current.superuserUrl,
          pending.refund.body.externalTransactionId,
        );
        return failed?.status === 'FAILED';
      }, WAIT);

      expect(failed).toMatchObject({ id: pending.pendingId, failure_code: 'PROCESSING_FAILED' });
      const retry = required(await retryOf(current.superuserUrl, pending.pendingId), 'retry');
      expect(retry.resolved_at).toBeInstanceOf(Date);
      expect(retry.consecutive_errors).toBe(1);
      expect(await eventTypesOf(current.superuserUrl, pending.pendingId)).toEqual([
        'WagerTransactionPendingReference',
        'WagerTransactionFailed',
      ]);
      expect(await storedHttpStatus(current.superuserUrl, pending.refund.idempotencyKey)).toBe(500);
      expect(await ledgerEntryCount(current.superuserUrl, pending.pendingId)).toBe(0);
      expect(await walletBalance(current.superuserUrl, pending.walletId)).toBe('990.00');

      const replay = await submitViaApi(api.baseUrl, pending.providerToken, pending.refund);
      expect(replay.status).toBe(500);
      const replayBody: unknown = await replay.json();
      expect(replayBody).toMatchObject({
        transactionId: pending.pendingId,
        status: 'FAILED',
        idempotentReplay: true,
      });
    } finally {
      await scheduler?.stop();
      await api.stop();
    }
  });

  it('keeps the pending reference alive when the failure path cannot write', async () => {
    const current = await createTestDatabase();
    database = current;
    const queues = await createTestQueues();
    const env = {
      DATABASE_URL: current.appUrl,
      PENDING_MAX_DETERMINISTIC_ERRORS: MAX_DETERMINISTIC_ERRORS,
      ...queues.env,
    };
    const api = await createTestApp({ roles: ['api'], env });
    let scheduler: TestApp | undefined;
    try {
      const pending = await pendingRefundWithProcessedBet(current, api);
      const errorsBefore = await failedPathErrors(api);
      await breakLedgerWrites(current);
      await breakOutboxWrites(current);

      scheduler = await createTestApp({ roles: ['scheduler'], env });
      await waitFor(async () => (await failedPathErrors(api)) > errorsBefore, WAIT);

      const alive = required(
        await transactionByExternalId(
          current.superuserUrl,
          pending.refund.body.externalTransactionId,
        ),
        'pending refund',
      );
      expect(alive.status).toBe('PENDING_REFERENCE');
      const retry = required(await retryOf(current.superuserUrl, pending.pendingId), 'retry');
      expect(retry.resolved_at).toBeNull();
      expect(retry.consecutive_errors).toBeGreaterThanOrEqual(Number(MAX_DETERMINISTIC_ERRORS));
      expect(await eventTypesOf(current.superuserUrl, pending.pendingId)).toEqual([
        'WagerTransactionPendingReference',
      ]);
      expect(await storedHttpStatus(current.superuserUrl, pending.refund.idempotencyKey)).toBe(202);
      expect(await ledgerEntryCount(current.superuserUrl, pending.pendingId)).toBe(0);
      expect(await walletBalance(current.superuserUrl, pending.walletId)).toBe('990.00');
    } finally {
      await scheduler?.stop();
      await api.stop();
    }
  });
});
