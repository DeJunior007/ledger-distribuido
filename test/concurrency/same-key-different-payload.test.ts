import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { FailureCode } from '@domain/shared/failure-code';
import { betCommand, createWalletViaApi, submitViaApi } from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import { spawnInstances } from '@test/support/spawn-instances';
import type { SpawnedInstances } from '@test/support/spawn-instances';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID, TestIssuer } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';

type Json = Readonly<Record<string, unknown>>;

const API_COUNT = 3;
const CONTENDERS = 12;
const INITIAL_UNITS = 1000;
const INITIAL_BALANCE = `${String(INITIAL_UNITS)}.00`;

interface Outcome {
  readonly index: number;
  readonly status: number;
  readonly body: Json;
}

interface Scenario {
  readonly database: TestDatabase;
  readonly issuer: TestIssuer;
  readonly apis: SpawnedInstances;
  readonly providerToken: string;
  readonly operatorToken: string;
}

class UnexpectedBodyError extends Error {
  constructor(body: unknown) {
    super(`expected a json object body, got ${JSON.stringify(body)}`);
    this.name = 'UnexpectedBodyError';
  }
}

const isJson = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const jsonOf = async (response: Response): Promise<Json> => {
  const parsed: unknown = await response.json();
  if (!isJson(parsed)) {
    throw new UnexpectedBodyError(parsed);
  }
  return parsed;
};

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

const startScenario = async (): Promise<Scenario> => {
  const database = await createTestDatabase();
  const queues = await createTestQueues();
  const issuer = await TestIssuer.start();
  try {
    const apis = await spawnInstances({
      role: 'api',
      count: API_COUNT,
      env: { DATABASE_URL: database.appUrl, ...queues.env, ...issuer.authConfig },
    });
    return {
      database,
      issuer,
      apis,
      providerToken: await issuer.token({ role: 'provider', providerId: TEST_PROVIDER_ID }),
      operatorToken: await issuer.token({ role: 'operator' }),
    };
  } catch (error) {
    await issuer.stop();
    throw error;
  }
};

const stopScenario = async (scenario: Scenario): Promise<void> => {
  await scenario.apis.stop();
  await scenario.issuer.stop();
};

const newWallet = (scenario: Scenario, index: number): Promise<TestWallet> =>
  createWalletViaApi(scenario.apis.instance(index % API_COUNT).baseUrl, scenario.operatorToken, {
    initialBalance: { amount: INITIAL_BALANCE, currency: 'BRL' },
  });

const amountFor = (index: number): string => `${String(index + 1)}.00`;

const fireTogether = async (
  scenario: Scenario,
  wallets: readonly TestWallet[],
  idempotencyKey: string,
): Promise<{ outcomes: Outcome[]; requests: ReturnType<typeof betCommand>[] }> => {
  const requests = wallets.map((wallet, index) =>
    betCommand({ wallet, idempotencyKey, amount: amountFor(index) }),
  );
  const outcomes = await Promise.all(
    requests.map(async (request, index) => {
      const response = await submitViaApi(
        scenario.apis.instance(index % API_COUNT).baseUrl,
        scenario.providerToken,
        request,
      );
      return { index, status: response.status, body: await jsonOf(response) };
    }),
  );
  return { outcomes, requests };
};

const expectOneEffect = async (
  scenario: Scenario,
  wallets: readonly TestWallet[],
  idempotencyKey: string,
): Promise<void> => {
  const { outcomes, requests } = await fireTogether(scenario, wallets, idempotencyKey);
  const winners = outcomes.filter((outcome) => outcome.status === 200);
  const losers = outcomes.filter((outcome) => outcome.status !== 200);
  expect(winners).toHaveLength(1);
  expect(losers).toHaveLength(CONTENDERS - 1);
  for (const loser of losers) {
    expect(loser.status).toBe(409);
    expect(loser.body.failureCode).toBe(FailureCode.IdempotencyKeyConflict);
    expect(loser.body.transactionId).toBeUndefined();
  }
  const [winner] = winners;
  const winnerRequest = winner === undefined ? undefined : requests[winner.index];
  expect(winner?.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });

  const transactions = await queryRows(
    scenario.database.superuserUrl,
    `SELECT id, wallet_id AS "walletId", external_transaction_id AS "externalTransactionId",
            amount::text AS amount, status
       FROM wager_transactions
      WHERE provider_id = $1 AND idempotency_key = $2`,
    [TEST_PROVIDER_ID, idempotencyKey],
  );
  expect(transactions).toEqual([
    {
      id: winner?.body.transactionId,
      walletId: winnerRequest?.body.walletId,
      externalTransactionId: winnerRequest?.body.externalTransactionId,
      amount: winnerRequest?.body.money.amount,
      status: 'PROCESSED',
    },
  ]);
  const records = await queryRows(
    scenario.database.superuserUrl,
    `SELECT transaction_id AS "transactionId", http_status AS "httpStatus"
       FROM idempotency_records
      WHERE provider_id = $1 AND idempotency_key = $2`,
    [TEST_PROVIDER_ID, idempotencyKey],
  );
  expect(records).toEqual([{ transactionId: winner?.body.transactionId, httpStatus: 200 }]);
  const entries = await queryRows(
    scenario.database.superuserUrl,
    `SELECT le.account_kind AS "accountKind", le.direction, le.amount::text AS amount
       FROM ledger_entries le
       JOIN wager_transactions wt ON wt.id = le.transaction_id
      WHERE wt.provider_id = $1 AND wt.idempotency_key = $2
      ORDER BY le.account_kind`,
    [TEST_PROVIDER_ID, idempotencyKey],
  );
  const winnerAmount = winnerRequest?.body.money.amount;
  expect(entries).toEqual([
    { accountKind: 'HOUSE', direction: 'CREDIT', amount: winnerAmount },
    { accountKind: 'WALLET', direction: 'DEBIT', amount: winnerAmount },
  ]);
  const balances = await queryRows(
    scenario.database.superuserUrl,
    'SELECT id, balance::text AS balance FROM wallets WHERE id = ANY($1::uuid[])',
    [[...new Set(wallets.map((wallet) => wallet.id))]],
  );
  const debitedWallet = winnerRequest?.body.walletId;
  const debitedBalance = `${String(INITIAL_UNITS - (winner?.index ?? 0) - 1)}.00`;
  expect(balances).toHaveLength(new Set(wallets.map((wallet) => wallet.id)).size);
  for (const row of balances) {
    expect(row.balance).toBe(row.id === debitedWallet ? debitedBalance : INITIAL_BALANCE);
  }
};

describe('concurrency 9: same idempotency key with different payloads', () => {
  it('keeps one effect on the same wallet and answers IDEMPOTENCY_KEY_CONFLICT to the rest', async () => {
    const scenario = await startScenario();
    try {
      const wallet = await newWallet(scenario, 0);
      const wallets = Array.from({ length: CONTENDERS }, () => wallet);
      await expectOneEffect(scenario, wallets, `idem-${crypto.randomUUID()}`);
    } finally {
      await stopScenario(scenario);
    }
  });

  it('keeps one effect across different wallets and answers IDEMPOTENCY_KEY_CONFLICT to the rest', async () => {
    const scenario = await startScenario();
    try {
      const wallets = await Promise.all(
        Array.from({ length: CONTENDERS }, (_, index) => newWallet(scenario, index)),
      );
      await expectOneEffect(scenario, wallets, `idem-${crypto.randomUUID()}`);
    } finally {
      await stopScenario(scenario);
    }
  });
});
