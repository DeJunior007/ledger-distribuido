import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import type { QueryResultRow } from 'pg';
import {
  betCommand,
  createWalletViaApi,
  refundCommand,
  rollbackCommand,
  submitViaApi,
  winCommand,
} from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import { createTestApp } from '@test/support/test-app';
import type { TestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID } from '@test/support/test-issuer';
import type { WagerTransactionRequest } from '@interfaces/http/schemas/wager-transaction.schema';

const UNKNOWN_WALLET_ID = '0198c000-0000-7000-8000-0000000000fe';
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface StoredRun extends QueryResultRow {
  readonly scope: string;
  readonly wallet_id: string | null;
  readonly consistent: boolean;
  readonly checked_entries: number;
  readonly stored_amount: string | null;
  readonly calculated_amount: string | null;
  readonly difference_amount: string | null;
  readonly currency: string | null;
  readonly first_divergent_version: number | null;
  readonly details: unknown;
}

let database: TestDatabase;
let app: TestApp;
let operatorToken: string;
let providerToken: string;

const queryRows = async <T extends QueryResultRow>(
  sql: string,
  values: readonly unknown[],
): Promise<T[]> => {
  const client = new Client({ connectionString: database.superuserUrl });
  await client.connect();
  try {
    return (await client.query<T>(sql, [...values])).rows;
  } finally {
    await client.end();
  }
};

const runsOf = (walletId: string): Promise<StoredRun[]> =>
  queryRows<StoredRun>(
    `SELECT scope, wallet_id, consistent, checked_entries, stored_amount::text AS stored_amount,
            calculated_amount::text AS calculated_amount, difference_amount::text AS difference_amount,
            currency, first_divergent_version, details
     FROM reconciliation_runs WHERE wallet_id = $1`,
    [walletId],
  );

const submitProcessed = async (request: WagerTransactionRequest): Promise<void> => {
  const response = await submitViaApi(app.baseUrl, providerToken, request);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: 'PROCESSED' });
};

const reconcile = (walletId: string): Promise<Response> =>
  fetch(`${app.baseUrl}/wallets/${walletId}/reconciliation`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${operatorToken}` },
  });

const playEveryKind = async (wallet: TestWallet): Promise<void> => {
  const bet = betCommand({ wallet, amount: '25.00' });
  await submitProcessed(bet);
  await submitProcessed(
    winCommand({
      wallet,
      amount: '15.00',
      roundId: bet.body.roundId,
      referenceExternalTransactionId: bet.body.externalTransactionId,
    }),
  );
  const refunded = betCommand({ wallet, amount: '10.00' });
  await submitProcessed(refunded);
  await submitProcessed(
    refundCommand({
      wallet,
      amount: '10.00',
      roundId: refunded.body.roundId,
      referenceExternalTransactionId: refunded.body.externalTransactionId,
    }),
  );
  const rolledBack = betCommand({ wallet, amount: '20.00' });
  await submitProcessed(rolledBack);
  await submitProcessed(
    rollbackCommand({
      wallet,
      amount: '20.00',
      roundId: rolledBack.body.roundId,
      referenceExternalTransactionId: rolledBack.body.externalTransactionId,
    }),
  );
};

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ roles: ['api'], env: { DATABASE_URL: database.appUrl } });
  operatorToken = await app.issuer.token({ role: 'operator' });
  providerToken = await app.issuer.token({ role: 'provider', providerId: TEST_PROVIDER_ID });
});

afterAll(async () => {
  await app.stop();
});

describe('POST /wallets/:walletId/reconciliation', () => {
  it('reports a consistent wallet after BET, WIN, REFUND and ROLLBACK and records the run', async () => {
    const wallet = await createWalletViaApi(app.baseUrl, operatorToken);
    await playEveryKind(wallet);

    const response = await reconcile(wallet.id);
    expect(response.status).toBe(200);
    const parsed: unknown = await response.json();
    const body: Record<string, unknown> =
      typeof parsed === 'object' && parsed !== null ? { ...parsed } : {};
    expect(body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '990.00', currency: 'BRL' },
      calculatedBalance: { amount: '990.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 7,
      chain: { valid: true, firstDivergentVersion: null, problems: [] },
      runId: expect.any(String),
      checkedAt: expect.stringMatching(ISO_INSTANT),
    });

    const { runId } = body;
    const stored = await queryRows<StoredRun>(
      `SELECT scope, wallet_id, consistent, checked_entries, stored_amount::text AS stored_amount,
              calculated_amount::text AS calculated_amount, difference_amount::text AS difference_amount,
              currency, first_divergent_version, details
       FROM reconciliation_runs WHERE id = $1`,
      [runId],
    );
    expect(stored).toEqual([
      {
        scope: 'WALLET',
        wallet_id: wallet.id,
        consistent: true,
        checked_entries: 7,
        stored_amount: '990.00',
        calculated_amount: '990.00',
        difference_amount: '0.00',
        currency: 'BRL',
        first_divergent_version: null,
        details: { problems: [] },
      },
    ]);
  });

  it('answers 404 for an unknown wallet without recording a run', async () => {
    const response = await reconcile(UNKNOWN_WALLET_ID);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toStartWith('application/problem+json');
    expect(await runsOf(UNKNOWN_WALLET_ID)).toEqual([]);
    const total = await queryRows<{ runs: number }>(
      'SELECT count(*)::int AS runs FROM reconciliation_runs WHERE wallet_id IS NULL OR wallet_id = $1',
      [UNKNOWN_WALLET_ID],
    );
    expect(total).toEqual([{ runs: 0 }]);
  });
});
