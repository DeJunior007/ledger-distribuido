import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import type { QueryResultRow } from 'pg';
import type { DestinationStream } from 'pino';
import { betCommand, createWalletViaApi, submitViaApi } from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import { skipLedgerConsistency } from '@test/support/ledger-consistency';
import { createTestApp } from '@test/support/test-app';
import type { TestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID } from '@test/support/test-issuer';

const DIVERGENCE_MESSAGE = 'wallet reconciliation found a divergence';
const ERROR_LEVEL = 50;
const MISMATCH_LINE = /^jungle_reconciliation_mismatch_total\{scope="wallet"\} (\d+)$/m;

type Json = Record<string, unknown>;

interface StoredWallet extends QueryResultRow {
  readonly balance: string;
  readonly version: number;
}

const isJson = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const logLines: string[] = [];

const logDestination: DestinationStream = {
  write(chunk: string): void {
    logLines.push(chunk);
  },
};

let database: TestDatabase;
let app: TestApp;
let operatorToken: string;
let providerToken: string;

const withClient = async <T>(work: (client: Client) => Promise<T>): Promise<T> => {
  const client = new Client({ connectionString: database.superuserUrl });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
};

const corrupt = (sql: string, values: readonly unknown[]): Promise<void> =>
  withClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query(sql, [...values]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });

const storedWallet = (walletId: string): Promise<StoredWallet[]> =>
  withClient(
    async (client) =>
      (
        await client.query<StoredWallet>(
          'SELECT balance::text AS balance, version FROM wallets WHERE id = $1',
          [walletId],
        )
      ).rows,
  );

const walletVersions = (walletId: string): Promise<number[]> =>
  withClient(async (client) =>
    (
      await client.query<{ wallet_version: number }>(
        'SELECT wallet_version FROM wallet_ledger_entries WHERE wallet_id = $1 ORDER BY wallet_version',
        [walletId],
      )
    ).rows.map((row) => row.wallet_version),
  );

const walletWithBets = async (amounts: readonly string[]): Promise<TestWallet> => {
  const wallet = await createWalletViaApi(app.baseUrl, operatorToken);
  for (const amount of amounts) {
    const response = await submitViaApi(app.baseUrl, providerToken, betCommand({ wallet, amount }));
    expect(response.status).toBe(200);
  }
  return wallet;
};

const mismatchTotal = async (): Promise<number> => {
  const response = await fetch(`${app.baseUrl}/metrics`);
  const match = MISMATCH_LINE.exec(await response.text());
  return match?.[1] === undefined ? 0 : Number.parseInt(match[1], 10);
};

const divergenceLogsFor = (walletId: string): Json[] =>
  logLines
    .map((line): unknown => JSON.parse(line))
    .filter(isJson)
    .filter((entry) => entry.message === DIVERGENCE_MESSAGE && entry.walletId === walletId);

const reconcile = async (walletId: string): Promise<Json> => {
  const response = await fetch(`${app.baseUrl}/wallets/${walletId}/reconciliation`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${operatorToken}` },
  });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  return isJson(body) ? body : {};
};

const expectDivergenceSignalled = (
  walletId: string,
  firstDivergentVersion: number,
  problems: readonly string[],
  hiddenAmounts: readonly string[],
): void => {
  const entries = divergenceLogsFor(walletId);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ level: ERROR_LEVEL, firstDivergentVersion, problems });
  const line = JSON.stringify(entries[0]);
  for (const amount of hiddenAmounts) {
    expect(line).not.toContain(amount);
  }
};

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({
    roles: ['api'],
    env: { DATABASE_URL: database.appUrl },
    logDestination,
  });
  operatorToken = await app.issuer.token({ role: 'operator' });
  providerToken = await app.issuer.token({ role: 'provider', providerId: TEST_PROVIDER_ID });
});

afterAll(async () => {
  await app.stop();
});

describe('wallet reconciliation divergence', () => {
  it('flags a balance corrupted upwards with a positive difference and leaves it corrupted', async () => {
    skipLedgerConsistency('the stored balance is raised on purpose to prove the divergence');
    const wallet = await walletWithBets(['25.00']);
    await corrupt('UPDATE wallets SET balance = 980.00 WHERE id = $1', [wallet.id]);
    const before = await mismatchTotal();

    const body = await reconcile(wallet.id);

    expect(body).toMatchObject({
      storedBalance: { amount: '980.00', currency: 'BRL' },
      calculatedBalance: { amount: '975.00', currency: 'BRL' },
      difference: { amount: '5.00', currency: 'BRL' },
      consistent: false,
      checkedEntries: 2,
      chain: { valid: false, firstDivergentVersion: 2, problems: ['LAST_BALANCE_MISMATCH'] },
    });
    expectDivergenceSignalled(wallet.id, 2, ['LAST_BALANCE_MISMATCH'], ['980.00', '975.00']);
    expect(await mismatchTotal()).toBe(before + 1);
    expect(await storedWallet(wallet.id)).toEqual([{ balance: '980.00', version: 2 }]);
  });

  it('flags a balance corrupted downwards with a negative difference and leaves it corrupted', async () => {
    skipLedgerConsistency('the stored balance is lowered on purpose to prove the divergence');
    const wallet = await walletWithBets(['25.00']);
    await corrupt('UPDATE wallets SET balance = 970.00 WHERE id = $1', [wallet.id]);
    const before = await mismatchTotal();

    const body = await reconcile(wallet.id);

    expect(body).toMatchObject({
      storedBalance: { amount: '970.00', currency: 'BRL' },
      calculatedBalance: { amount: '975.00', currency: 'BRL' },
      difference: { amount: '-5.00', currency: 'BRL' },
      consistent: false,
      chain: { valid: false, firstDivergentVersion: 2, problems: ['LAST_BALANCE_MISMATCH'] },
    });
    expectDivergenceSignalled(wallet.id, 2, ['LAST_BALANCE_MISMATCH'], ['970.00', '975.00']);
    expect(await mismatchTotal()).toBe(before + 1);
    expect(await storedWallet(wallet.id)).toEqual([{ balance: '970.00', version: 2 }]);
  });

  it('flags a deleted middle entry at the first broken version and does not restore it', async () => {
    skipLedgerConsistency('a ledger entry in the middle of the chain is deleted on purpose');
    const wallet = await walletWithBets(['10.00', '10.00', '10.00']);
    await corrupt(
      "DELETE FROM ledger_entries WHERE account_kind = 'WALLET' AND wallet_id = $1 AND wallet_version = 3",
      [wallet.id],
    );
    const before = await mismatchTotal();

    const body = await reconcile(wallet.id);

    expect(body).toMatchObject({
      storedBalance: { amount: '970.00', currency: 'BRL' },
      calculatedBalance: { amount: '980.00', currency: 'BRL' },
      difference: { amount: '-10.00', currency: 'BRL' },
      consistent: false,
      checkedEntries: 3,
      chain: {
        valid: false,
        firstDivergentVersion: 4,
        problems: ['VERSION_GAP', 'BEFORE_AFTER_MISMATCH'],
      },
    });
    expectDivergenceSignalled(
      wallet.id,
      4,
      ['VERSION_GAP', 'BEFORE_AFTER_MISMATCH'],
      ['970.00', '980.00'],
    );
    expect(await mismatchTotal()).toBe(before + 1);
    expect(await storedWallet(wallet.id)).toEqual([{ balance: '970.00', version: 4 }]);
    expect(await walletVersions(wallet.id)).toEqual([1, 2, 4]);
  });
});
