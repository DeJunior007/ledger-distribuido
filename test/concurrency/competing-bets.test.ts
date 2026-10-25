import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { betCommand, createWalletViaApi, submitViaApi } from '@test/support/fixtures';
import { spawnInstances } from '@test/support/spawn-instances';
import type { SpawnedInstances } from '@test/support/spawn-instances';
import { createTestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID, TestIssuer } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';

const API_COUNT = 2;
const PROCESS_ENV = { DB_POOL_MAX: '10' } as const;

type Json = Record<string, unknown>;

interface Answer {
  readonly status: number;
  readonly body: Json;
}

const queryRows = async (
  databaseUrl: string,
  sql: string,
  params: readonly unknown[],
): Promise<Json[]> => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<Json>(sql, [...params]);
    return result.rows;
  } finally {
    await client.end();
  }
};

const readResponse = async (response: Response): Promise<Answer> => {
  const parsed: unknown = await response.json();
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`unexpected body: ${JSON.stringify(parsed)}`);
  }
  return { status: response.status, body: { ...parsed } };
};

const withoutReplayFlag = (body: Json): Json =>
  Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'idempotentReplay'));

const ledgerOf = (databaseUrl: string, walletId: string): Promise<Json[]> =>
  queryRows(
    databaseUrl,
    `SELECT w.balance::text AS balance, w.version,
            e.transaction_id::text AS "transactionId", e.direction, e.amount::text AS amount,
            e.balance_after::text AS "balanceAfter"
       FROM wallets w
       LEFT JOIN wallet_ledger_entries e ON e.wallet_id = w.id
      WHERE w.id = $1
      ORDER BY e.wallet_version`,
    [walletId],
  );

describe('two competing bets on different apis', () => {
  it('processes one, rejects the other for insufficient funds and replays both', async () => {
    const database = await createTestDatabase();
    const queues = await createTestQueues();
    const issuer = await TestIssuer.start();
    const env = {
      DATABASE_URL: database.appUrl,
      ...queues.env,
      ...issuer.authConfig,
      ...PROCESS_ENV,
    };
    const groups: SpawnedInstances[] = [];
    try {
      const apis = await spawnInstances({ role: 'api', count: API_COUNT, env });
      groups.push(apis);
      const operatorToken = await issuer.token({ role: 'operator' });
      const providerToken = await issuer.token({ role: 'provider', providerId: TEST_PROVIDER_ID });
      const wallet = await createWalletViaApi(apis.instance(0).baseUrl, operatorToken, {
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      const bets = [
        betCommand({ wallet, amount: '80.00' }),
        betCommand({ wallet, amount: '80.00' }),
      ] as const;

      const first = await Promise.all(
        bets.map((bet, index) =>
          submitViaApi(apis.instance(index).baseUrl, providerToken, bet).then(readResponse),
        ),
      );

      const processed = first.filter((answer) => answer.status === 200);
      const rejected = first.filter((answer) => answer.status === 422);
      expect(processed).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(processed[0]?.body).toEqual({
        transactionId: expect.any(String),
        status: 'PROCESSED',
        kind: 'BET',
        balance: { amount: '20.00', currency: 'BRL' },
        idempotentReplay: false,
      });
      expect(typeof rejected[0]?.body.transactionId).toBe('string');
      expect(rejected[0]?.body).toMatchObject({
        status: 'REJECTED',
        kind: 'BET',
        failureCode: 'INSUFFICIENT_FUNDS',
        balance: { amount: '20.00', currency: 'BRL' },
        idempotentReplay: false,
      });

      const transactions = await queryRows(
        database.appUrl,
        `SELECT status, failure_code AS "failureCode" FROM wager_transactions
          WHERE wallet_id = $1 AND kind = 'BET' ORDER BY status`,
        [wallet.id],
      );
      expect(transactions).toEqual([
        { status: 'PROCESSED', failureCode: null },
        { status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' },
      ]);
      const ledgerBefore = await ledgerOf(database.appUrl, wallet.id);
      expect(ledgerBefore.at(-1)).toMatchObject({ balance: '20.00' });
      const debits = ledgerBefore.filter((row) => row.direction === 'DEBIT');
      expect(debits).toEqual([
        {
          balance: '20.00',
          version: expect.any(Number),
          transactionId: processed[0]?.body.transactionId,
          direction: 'DEBIT',
          amount: '80.00',
          balanceAfter: '20.00',
        },
      ]);

      const resent = await Promise.all(
        bets.map((bet, index) =>
          submitViaApi(apis.instance(API_COUNT - 1 - index).baseUrl, providerToken, bet).then(
            readResponse,
          ),
        ),
      );

      resent.forEach((answer, index) => {
        const original = first[index];
        expect(answer.status).toBe(original?.status ?? 0);
        expect(answer.body.idempotentReplay).toBe(true);
        expect(withoutReplayFlag(answer.body)).toEqual(withoutReplayFlag(original?.body ?? {}));
      });
      expect(await ledgerOf(database.appUrl, wallet.id)).toEqual(ledgerBefore);
    } finally {
      await Promise.all(groups.map((group) => group.stop()));
      await issuer.stop();
    }
  });
});
