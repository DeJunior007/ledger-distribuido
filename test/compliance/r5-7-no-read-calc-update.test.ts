import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { betCommand, createWalletViaApi, submitViaApi } from '@test/support/fixtures';
import type { WagerTransactionRequest } from '@interfaces/http/schemas/wager-transaction.schema';
import { createTestApp } from '@test/support/test-app';
import type { TestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID } from '@test/support/test-issuer';

const RANDOM_DEBITS = 200;
const INITIAL_CENTS = 100_000n;
const MIN_DEBIT_CENTS = 100;
const DEBIT_SPREAD_CENTS = 1400;
const TRANSIENT_STATUS = 503;
const MAX_ATTEMPTS = 10;
const RETRY_BACKOFF_MS = 200;

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

const toDecimal = (cents: bigint): string =>
  `${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, '0')}`;

const toCents = (decimal: unknown): bigint => {
  const [whole = '0', fraction = '00'] = String(decimal).split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
};

const randomDebitCents = (): bigint =>
  BigInt(MIN_DEBIT_CENTS + Math.floor(Math.random() * DEBIT_SPREAD_CENTS));

const submitWithRetry = async (
  baseUrl: string,
  providerToken: string,
  request: WagerTransactionRequest,
): Promise<number> => {
  for (let attempt = 1; ; attempt += 1) {
    const response = await submitViaApi(baseUrl, providerToken, request);
    await response.arrayBuffer();
    if (response.status !== TRANSIENT_STATUS || attempt >= MAX_ATTEMPTS) {
      return response.status;
    }
    await Bun.sleep(RETRY_BACKOFF_MS * attempt);
  }
};

const betsOf = (databaseUrl: string, walletId: string): Promise<Record<string, unknown>[]> =>
  queryRows(
    databaseUrl,
    `SELECT t.id, t.status, t.failure_code AS "failureCode", t.amount::text AS amount,
            (SELECT count(*)::int FROM wallet_ledger_entries e WHERE e.transaction_id = t.id) AS entries
       FROM wager_transactions t
      WHERE t.wallet_id = $1 AND t.kind = 'BET'`,
    [walletId],
  );

const walletOf = async (
  databaseUrl: string,
  walletId: string,
): Promise<Record<string, unknown>> => {
  const rows = await queryRows(
    databaseUrl,
    `SELECT w.balance::text AS balance,
            (SELECT count(*)::int FROM wallet_ledger_entries e
              WHERE e.wallet_id = w.id AND e.direction = 'DEBIT') AS debits,
            (SELECT count(*)::int FROM wallet_ledger_entries e
              WHERE e.wallet_id = w.id AND e.balance_after < 0) AS negatives
       FROM wallets w
      WHERE w.id = $1`,
    [walletId],
  );
  return rows[0] ?? {};
};

const withApp = async (
  run: (app: TestApp, databaseUrl: string) => Promise<void>,
): Promise<void> => {
  const database = await createTestDatabase();
  const app = await createTestApp({ roles: ['api'], env: { DATABASE_URL: database.appUrl } });
  try {
    await run(app, database.appUrl);
  } finally {
    await app.stop();
  }
};

describe('§5.7 nada de ler, calcular e atualizar fora da transação', () => {
  it('processes one of two concurrent 80.00 bets on a 100.00 wallet', async () => {
    await withApp(async (app, databaseUrl) => {
      const operatorToken = await app.issuer.token({ role: 'operator' });
      const providerToken = await app.issuer.token({
        role: 'provider',
        providerId: TEST_PROVIDER_ID,
      });
      const wallet = await createWalletViaApi(app.baseUrl, operatorToken, {
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const statuses = await Promise.all(
        [betCommand({ wallet, amount: '80.00' }), betCommand({ wallet, amount: '80.00' })].map(
          (bet) => submitWithRetry(app.baseUrl, providerToken, bet),
        ),
      );

      expect([...statuses].sort()).toEqual([200, 422]);
      const bets = await betsOf(databaseUrl, wallet.id);
      expect(
        bets
          .map((bet) => ({
            status: bet.status,
            failureCode: bet.failureCode,
            entries: bet.entries,
          }))
          .sort((left, right) => String(left.status).localeCompare(String(right.status))),
      ).toEqual([
        { status: 'PROCESSED', failureCode: null, entries: 1 },
        { status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', entries: 0 },
      ]);
      expect(await walletOf(databaseUrl, wallet.id)).toEqual({
        balance: '20.00',
        debits: 1,
        negatives: 0,
      });
    });
  });

  it('lands on the exact balance after 200 random concurrent debits', async () => {
    await withApp(async (app, databaseUrl) => {
      const operatorToken = await app.issuer.token({ role: 'operator' });
      const providerToken = await app.issuer.token({
        role: 'provider',
        providerId: TEST_PROVIDER_ID,
      });
      const wallet = await createWalletViaApi(app.baseUrl, operatorToken, {
        initialBalance: { amount: toDecimal(INITIAL_CENTS), currency: 'BRL' },
      });
      const bets = Array.from({ length: RANDOM_DEBITS }, () =>
        betCommand({ wallet, amount: toDecimal(randomDebitCents()) }),
      );

      const statuses = await Promise.all(
        bets.map((bet) => submitWithRetry(app.baseUrl, providerToken, bet)),
      );

      expect(statuses.filter((status) => status !== 200 && status !== 422)).toEqual([]);
      const rows = await betsOf(databaseUrl, wallet.id);
      expect(rows).toHaveLength(RANDOM_DEBITS);
      const processed = rows.filter((row) => row.status === 'PROCESSED');
      const rejected = rows.filter((row) => row.status === 'REJECTED');
      expect(processed.length + rejected.length).toBe(RANDOM_DEBITS);
      expect(processed.length).toBe(statuses.filter((status) => status === 200).length);
      expect(rejected.length).toBeGreaterThan(0);
      expect(processed.filter((row) => row.entries !== 1)).toEqual([]);
      expect(rejected.filter((row) => row.entries !== 0)).toEqual([]);
      expect(rejected.filter((row) => row.failureCode !== 'INSUFFICIENT_FUNDS')).toEqual([]);
      const applied = processed.reduce((sum, row) => sum + toCents(row.amount), 0n);
      const finalCents = INITIAL_CENTS - applied;
      expect(finalCents >= 0n).toBe(true);
      expect(rejected.filter((row) => toCents(row.amount) <= finalCents)).toEqual([]);
      expect(await walletOf(databaseUrl, wallet.id)).toEqual({
        balance: toDecimal(finalCents),
        debits: processed.length,
        negatives: 0,
      });
    });
  });
});
