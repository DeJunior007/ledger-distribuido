import { afterEach, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import type { QueryResultRow } from 'pg';
import {
  betCommand,
  createWalletViaUseCase,
  rollbackCommand,
  submitViaApi,
  winCommand,
} from '@test/support/fixtures';
import { createTestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID } from '@test/support/test-issuer';
import { waitFor } from '@test/support/wait-for';

const WAIT = { timeoutMs: 20_000, intervalMs: 100 } as const;
const BACKED_OFF_ATTEMPTS = 3;
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
  readonly transaction_id: string;
  readonly attempts: number;
  readonly next_attempt_at: Date;
  readonly resolved_at: Date | null;
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

const retriesOf = async (
  databaseUrl: string,
  transactionIds: readonly string[],
): Promise<Map<string, RetryRow>> => {
  const rows = await query<RetryRow>(
    databaseUrl,
    `select transaction_id, attempts, next_attempt_at, resolved_at from pending_reference_retries
      where transaction_id = any($1::uuid[])`,
    [transactionIds],
  );
  return new Map(rows.map((row) => [row.transaction_id, row]));
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

describe('pending reference chains', () => {
  let database: TestDatabase | undefined;

  afterEach(async () => {
    if (database !== undefined) {
      await releaseLeases(database.superuserUrl);
    }
    database = undefined;
  });

  it('resolves a rollback of a win whose bet arrives last in cascade', async () => {
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
      const win = winCommand({
        wallet,
        roundId,
        amount: WIN_AMOUNT,
        referenceExternalTransactionId: bet.body.externalTransactionId,
      });
      const rollback = rollbackCommand({
        wallet,
        roundId,
        amount: WIN_AMOUNT,
        referenceExternalTransactionId: win.body.externalTransactionId,
      });

      const winAccepted = await submitViaApi(app.baseUrl, providerToken, win);
      expect(winAccepted.status).toBe(202);
      const rollbackAccepted = await submitViaApi(app.baseUrl, providerToken, rollback);
      expect(rollbackAccepted.status).toBe(202);
      const rollbackBody: unknown = await rollbackAccepted.json();
      expect(rollbackBody).toMatchObject({ status: 'PENDING_REFERENCE', kind: 'ROLLBACK' });

      const pendingWin = required(
        await transactionByExternalId(current.superuserUrl, win.body.externalTransactionId),
        'pending win',
      );
      const pendingRollback = required(
        await transactionByExternalId(current.superuserUrl, rollback.body.externalTransactionId),
        'pending rollback',
      );
      const chain = [pendingWin.id, pendingRollback.id];

      let waiting = new Map<string, RetryRow>();
      await waitFor(async () => {
        waiting = await retriesOf(current.superuserUrl, chain);
        return chain.every((id) => (waiting.get(id)?.attempts ?? 0) >= BACKED_OFF_ATTEMPTS);
      }, WAIT);
      for (const id of chain) {
        expect(waiting.get(id)?.resolved_at).toBeNull();
      }
      for (const external of [
        win.body.externalTransactionId,
        rollback.body.externalTransactionId,
      ]) {
        expect((await transactionByExternalId(current.superuserUrl, external))?.status).toBe(
          'PENDING_REFERENCE',
        );
      }
      expect(await walletBalance(current.superuserUrl, wallet.id)).toBe('1000.00');
      const rollbackScheduledAt = required(
        waiting.get(pendingRollback.id),
        'rollback retry',
      ).next_attempt_at.getTime();

      const placed = await submitViaApi(app.baseUrl, providerToken, bet);
      expect(placed.status).toBe(200);
      const placedBet = required(
        await transactionByExternalId(current.superuserUrl, bet.body.externalTransactionId),
        'placed bet',
      );
      expect(placedBet.status).toBe('PROCESSED');

      let settled = new Map<string, RetryRow>();
      await waitFor(async () => {
        settled = await retriesOf(current.superuserUrl, chain);
        return chain.every((id) => Boolean(settled.get(id)?.resolved_at));
      }, WAIT);
      const winResolvedAt = required(
        settled.get(pendingWin.id)?.resolved_at ?? undefined,
        'win resolution',
      ).getTime();
      const rollbackResolvedAt = required(
        settled.get(pendingRollback.id)?.resolved_at ?? undefined,
        'rollback resolution',
      ).getTime();
      expect(winResolvedAt).toBeLessThanOrEqual(rollbackResolvedAt);
      expect(rollbackResolvedAt).toBeLessThan(rollbackScheduledAt);

      expect(
        await transactionByExternalId(current.superuserUrl, win.body.externalTransactionId),
      ).toMatchObject({
        status: 'PROCESSED',
        failure_code: null,
        reference_transaction_id: placedBet.id,
      });
      expect(
        await transactionByExternalId(current.superuserUrl, rollback.body.externalTransactionId),
      ).toMatchObject({
        status: 'PROCESSED',
        failure_code: null,
        reference_transaction_id: pendingWin.id,
      });
      expect(await walletBalance(current.superuserUrl, wallet.id)).toBe('990.00');

      const replay = await submitViaApi(app.baseUrl, providerToken, rollback);
      expect(replay.status).toBe(200);
      const replayBody: unknown = await replay.json();
      expect(replayBody).toMatchObject({
        transactionId: pendingRollback.id,
        status: 'PROCESSED',
        kind: 'ROLLBACK',
        balance: { amount: '990.00', currency: 'BRL' },
        idempotentReplay: true,
      });
    } finally {
      await app.stop();
    }
  });
});
