import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import type { WagerTransactionRequest } from '@interfaces/http/schemas/wager-transaction.schema';
import { betCommand, createWalletViaApi, submitViaApi } from '@test/support/fixtures';
import { spawnInstances } from '@test/support/spawn-instances';
import type { SpawnedInstances } from '@test/support/spawn-instances';
import { createTestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID, TestIssuer } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';

const API_COUNT = 2;

interface Outcome {
  readonly status: number;
  readonly transactionId: unknown;
  readonly idempotentReplay: unknown;
}

const queryRows = async (
  databaseUrl: string,
  sql: string,
  params: readonly unknown[] = [],
): Promise<Record<string, unknown>[]> => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<Record<string, unknown>>(sql, [...params]);
    return result.rows;
  } finally {
    await client.end();
  }
};

const submitToEvery = (
  apis: SpawnedInstances,
  providerToken: string,
  request: WagerTransactionRequest,
): Promise<Outcome[]> =>
  Promise.all(
    apis.instances.map(async (api) => {
      const response = await submitViaApi(api.baseUrl, providerToken, request);
      const body: unknown = await response.json();
      const json = typeof body === 'object' && body !== null ? body : {};
      const transactionId: unknown = Reflect.get(json, 'transactionId');
      const idempotentReplay: unknown = Reflect.get(json, 'idempotentReplay');
      return { status: response.status, transactionId, idempotentReplay };
    }),
  );

describe('§5.2 idempotência persistente, sem cache em memória', () => {
  it('keeps one effect for the same request across two api processes and a restart of both', async () => {
    const database = await createTestDatabase();
    const queues = await createTestQueues();
    const issuer = await TestIssuer.start();
    const apis = await spawnInstances({
      role: 'api',
      count: API_COUNT,
      env: { DATABASE_URL: database.appUrl, ...queues.env, ...issuer.authConfig },
    });
    try {
      const operatorToken = await issuer.token({ role: 'operator' });
      const providerToken = await issuer.token({ role: 'provider', providerId: TEST_PROVIDER_ID });
      const wallet = await createWalletViaApi(apis.instance(0).baseUrl, operatorToken, {
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      const bet = betCommand({ wallet, amount: '10.00' });

      const first = await submitToEvery(apis, providerToken, bet);
      await Promise.all(apis.instances.map((api) => api.restart()));
      const afterRestart = await submitToEvery(apis, providerToken, bet);

      const outcomes = [...first, ...afterRestart];
      expect(outcomes.map((outcome) => outcome.status)).toEqual(outcomes.map(() => 200));
      expect(new Set(outcomes.map((outcome) => outcome.transactionId)).size).toBe(1);
      expect(first.filter((outcome) => outcome.idempotentReplay === true)).toHaveLength(
        API_COUNT - 1,
      );
      expect(afterRestart.map((outcome) => outcome.idempotentReplay)).toEqual([true, true]);
      expect(outcomes[0]?.transactionId).toBeString();
      expect(
        await queryRows(
          database.superuserUrl,
          `SELECT (SELECT count(*)::int FROM wager_transactions
                    WHERE provider_id = $1 AND idempotency_key = $2) AS transactions,
                  (SELECT count(*)::int FROM idempotency_records
                    WHERE provider_id = $1 AND idempotency_key = $2) AS records,
                  (SELECT count(*)::int FROM wallet_ledger_entries
                    WHERE wallet_id = $3 AND direction = 'DEBIT') AS debits,
                  (SELECT balance::text FROM wallets WHERE id = $3) AS balance`,
          [TEST_PROVIDER_ID, bet.idempotencyKey, wallet.id],
        ),
      ).toEqual([{ transactions: 1, records: 1, debits: 1, balance: '90.00' }]);
    } finally {
      await apis.stop();
      await issuer.stop();
    }
  });
});
