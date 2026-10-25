import { afterEach, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import type { QueryResultRow } from 'pg';
import {
  betCommand,
  createWalletViaUseCase,
  refundCommand,
  submitViaApi,
} from '@test/support/fixtures';
import type { WagerCommandOptions } from '@test/support/fixtures';
import { createTestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID } from '@test/support/test-issuer';
import { waitFor } from '@test/support/wait-for';

const WAIT = { timeoutMs: 20_000, intervalMs: 100 } as const;
const INITIAL_BALANCE = '1000.00';
const OVERDRAFT_AMOUNT = '5000.00';
const PARTIAL_AMOUNT = '4.00';

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
  readonly resolved_at: Date | null;
  readonly locked_by: string | null;
}

interface PendingRejection {
  readonly name: string;
  readonly failureCode: string;
  readonly referenceStatus: string;
  readonly balance: string;
  readonly bet: (wallet: WagerCommandOptions['wallet'], roundId: string) => WagerCommandOptions;
  readonly refund: (wallet: WagerCommandOptions['wallet'], roundId: string) => WagerCommandOptions;
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
    'select resolved_at, locked_by from pending_reference_retries where transaction_id = $1',
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

const releaseLeases = async (databaseUrl: string): Promise<void> => {
  await query(
    databaseUrl,
    `update pending_reference_retries set locked_until = null, locked_by = null
      where resolved_at is null`,
    [],
  );
};

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

const rejections: readonly PendingRejection[] = [
  {
    name: 'rejects with REFERENCE_NOT_PROCESSED when the referenced bet was rejected',
    failureCode: 'REFERENCE_NOT_PROCESSED',
    referenceStatus: 'REJECTED',
    balance: INITIAL_BALANCE,
    bet: (wallet, roundId) => ({ wallet, roundId, amount: OVERDRAFT_AMOUNT }),
    refund: (wallet, roundId) => ({ wallet, roundId, amount: OVERDRAFT_AMOUNT }),
  },
  {
    name: 'rejects with REFERENCE_MISMATCH when the referenced bet belongs to another round',
    failureCode: 'REFERENCE_MISMATCH',
    referenceStatus: 'PROCESSED',
    balance: '990.00',
    bet: (wallet) => ({ wallet, roundId: `round-${crypto.randomUUID()}` }),
    refund: (wallet, roundId) => ({ wallet, roundId }),
  },
  {
    name: 'rejects with AMOUNT_MISMATCH when the refund amount differs from the bet',
    failureCode: 'AMOUNT_MISMATCH',
    referenceStatus: 'PROCESSED',
    balance: '990.00',
    bet: (wallet, roundId) => ({ wallet, roundId }),
    refund: (wallet, roundId) => ({ wallet, roundId, amount: PARTIAL_AMOUNT }),
  },
];

describe('pending reference rejections', () => {
  let database: TestDatabase | undefined;

  afterEach(async () => {
    if (database !== undefined) {
      await releaseLeases(database.superuserUrl);
    }
    database = undefined;
  });

  for (const rejection of rejections) {
    it(rejection.name, async () => {
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
        const bet = betCommand(rejection.bet(wallet, roundId));
        const refund = refundCommand({
          ...rejection.refund(wallet, roundId),
          referenceExternalTransactionId: bet.body.externalTransactionId,
        });

        const accepted = await submitViaApi(app.baseUrl, providerToken, refund);
        expect(accepted.status).toBe(202);
        const pending = required(
          await transactionByExternalId(current.superuserUrl, refund.body.externalTransactionId),
          'pending refund',
        );

        await submitViaApi(app.baseUrl, providerToken, bet);
        const reference = await waitForStatus(
          current.superuserUrl,
          bet.body.externalTransactionId,
          rejection.referenceStatus,
        );

        const rejected = await waitForStatus(
          current.superuserUrl,
          refund.body.externalTransactionId,
          'REJECTED',
        );
        expect(rejected).toMatchObject({
          id: pending.id,
          failure_code: rejection.failureCode,
          reference_transaction_id: reference.id,
        });
        const retry = required(await retryOf(current.superuserUrl, pending.id), 'refund retry');
        expect(retry.resolved_at).toBeInstanceOf(Date);
        expect(retry.locked_by).toBeNull();
        expect(await ledgerEntryCount(current.superuserUrl, pending.id)).toBe(0);
        expect(await walletBalance(current.superuserUrl, wallet.id)).toBe(rejection.balance);
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
          failureCode: rejection.failureCode,
          idempotentReplay: true,
        });
      } finally {
        await app.stop();
      }
    });
  }
});
