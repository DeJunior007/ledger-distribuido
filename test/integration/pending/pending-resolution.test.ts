import { afterEach, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import type { QueryResultRow } from 'pg';
import {
  betCommand,
  createWalletViaUseCase,
  refundCommand,
  submitViaApi,
} from '@test/support/fixtures';
import { createTestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID } from '@test/support/test-issuer';
import { waitFor } from '@test/support/wait-for';

const WAIT = { timeoutMs: 20_000, intervalMs: 100 } as const;
const BACKED_OFF_ATTEMPTS = 3;

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
  readonly next_attempt_at: Date;
  readonly resolved_at: Date | null;
}

interface EventRow {
  readonly event_type: string;
  readonly causation_id: string | null;
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
    `select attempts, next_attempt_at, resolved_at from pending_reference_retries
      where transaction_id = $1`,
    [transactionId],
  );
  return rows[0];
};

const eventsOf = (databaseUrl: string, transactionId: string): Promise<EventRow[]> =>
  query<EventRow>(
    databaseUrl,
    `select event_type, payload->>'causationId' as causation_id from outbox_messages
      where payload->'data'->>'transactionId' = $1
      order by occurred_at, event_type`,
    [transactionId],
  );

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

describe('pending reference resolution', () => {
  let database: TestDatabase | undefined;

  afterEach(async () => {
    if (database !== undefined) {
      await releaseLeases(database.superuserUrl);
    }
    database = undefined;
  });

  it('resolves a refund that arrived before its bet as soon as the bet is processed', async () => {
    const current = await createTestDatabase();
    database = current;
    const app = await createTestApp({
      roles: ['api', 'scheduler'],
      env: { DATABASE_URL: current.appUrl },
    });
    try {
      const providerToken = await app.issuer.token({
        role: 'provider',
        providerId: TEST_PROVIDER_ID,
      });
      const wallet = await createWalletViaUseCase(app);
      const roundId = `round-${crypto.randomUUID()}`;
      const bet = betCommand({ wallet, roundId });
      const refund = refundCommand({
        wallet,
        roundId,
        referenceExternalTransactionId: bet.body.externalTransactionId,
      });

      const accepted = await submitViaApi(app.baseUrl, providerToken, refund);
      expect(accepted.status).toBe(202);
      const acceptedBody: unknown = await accepted.json();
      expect(acceptedBody).toMatchObject({
        status: 'PENDING_REFERENCE',
        kind: 'REFUND',
        idempotentReplay: false,
      });
      const pending = required(
        await transactionByExternalId(current.superuserUrl, refund.body.externalTransactionId),
        'pending refund',
      );
      expect(pending).toMatchObject({
        status: 'PENDING_REFERENCE',
        reference_transaction_id: null,
      });
      expect(acceptedBody).toMatchObject({ transactionId: pending.id });

      let backedOff: RetryRow | undefined;
      await waitFor(async () => {
        backedOff = await retryOf(current.superuserUrl, pending.id);
        return backedOff !== undefined && backedOff.attempts >= BACKED_OFF_ATTEMPTS;
      }, WAIT);
      const scheduled = required(backedOff, 'pending retry');
      expect(scheduled.resolved_at).toBeNull();
      expect(
        (await transactionByExternalId(current.superuserUrl, refund.body.externalTransactionId))
          ?.status,
      ).toBe('PENDING_REFERENCE');
      const scheduledAt = scheduled.next_attempt_at.getTime();

      const placed = await submitViaApi(app.baseUrl, providerToken, bet);
      expect(placed.status).toBe(200);
      const placedBody: unknown = await placed.json();
      expect(placedBody).toMatchObject({ status: 'PROCESSED', balance: { amount: '990.00' } });

      let resolved: RetryRow | undefined;
      await waitFor(async () => {
        resolved = await retryOf(current.superuserUrl, pending.id);
        return resolved?.resolved_at !== null && resolved?.resolved_at !== undefined;
      }, WAIT);
      expect(resolved?.resolved_at?.getTime()).toBeLessThan(scheduledAt);

      const placedBet = await transactionByExternalId(
        current.superuserUrl,
        bet.body.externalTransactionId,
      );
      expect(
        await transactionByExternalId(current.superuserUrl, refund.body.externalTransactionId),
      ).toMatchObject({
        status: 'PROCESSED',
        failure_code: null,
        reference_transaction_id: placedBet?.id,
      });
      expect(await walletBalance(current.superuserUrl, wallet.id)).toBe('1000.00');

      const replay = await submitViaApi(app.baseUrl, providerToken, refund);
      expect(replay.status).toBe(200);
      const replayBody: unknown = await replay.json();
      expect(replayBody).toMatchObject({
        transactionId: pending.id,
        status: 'PROCESSED',
        kind: 'REFUND',
        balance: { amount: '1000.00', currency: 'BRL' },
        idempotentReplay: true,
      });

      const events = await eventsOf(current.superuserUrl, pending.id);
      expect(events[0]?.event_type).toBe('WagerTransactionPendingReference');
      expect(
        events
          .slice(1)
          .map((event) => event.event_type)
          .sort(),
      ).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
      expect(events.slice(1).map((event) => event.causation_id)).toEqual([pending.id, pending.id]);
    } finally {
      await app.stop();
    }
  });
});
