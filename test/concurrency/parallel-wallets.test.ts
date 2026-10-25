import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import {
  betCommand,
  createWalletViaApi,
  lossCommand,
  refundCommand,
  rollbackCommand,
  submitViaApi,
  winCommand,
} from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import { spawnInstances } from '@test/support/spawn-instances';
import type { SpawnedInstances } from '@test/support/spawn-instances';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID, TestIssuer } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';
import type { WagerTransactionRequest } from '@interfaces/http/schemas/wager-transaction.schema';
import { waitFor } from '@test/support/wait-for';

const WALLET_COUNT = 20;
const BETS_PER_WALLET = 15;
const WINS_PER_WALLET = 5;
const LOSSES_PER_WALLET = 3;
const OPERATIONS_PER_WALLET = 25;
const INITIAL_BALANCE_CENTS = 100_000n;
const API_COUNT = 3;
const SETTLE_WAIT = { timeoutMs: 90_000, intervalMs: 250 } as const;
const TRANSIENT_STATUS = 503;
const MAX_ATTEMPTS = 10;
const RETRY_BACKOFF_MS = 200;
const CONTENDED_SERIES = /^jungle_lock_conflicts_total\{([^}]*)\}\s+(\S+)$/;

interface ProcessEnvironment {
  readonly database: TestDatabase;
  readonly issuer: TestIssuer;
  readonly env: Readonly<Record<string, string>>;
}

interface WalletPlan {
  readonly wallet: TestWallet;
  readonly requests: readonly WagerTransactionRequest[];
  readonly expectedBalanceCents: bigint;
  readonly expectedWalletEntries: number;
}

const prepareEnvironment = async (): Promise<ProcessEnvironment> => {
  const database = await createTestDatabase();
  const queues = await createTestQueues();
  const issuer = await TestIssuer.start();
  return {
    database,
    issuer,
    env: { DATABASE_URL: database.appUrl, ...queues.env, ...issuer.authConfig },
  };
};

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

const toDecimal = (cents: bigint): string => {
  const whole = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(2, '0');
  return `${whole.toString()}.${fraction}`;
};

const betCents = (walletIndex: number, betIndex: number): bigint =>
  BigInt((betIndex + 1) * 100 + walletIndex);

const winCents = (walletIndex: number, betIndex: number): bigint =>
  BigInt(150 + betIndex * 100 + walletIndex);

const planFor = (wallet: TestWallet, walletIndex: number): WalletPlan => {
  const bets = Array.from({ length: BETS_PER_WALLET }, (_, betIndex) =>
    betCommand({ wallet, amount: toDecimal(betCents(walletIndex, betIndex)) }),
  );
  const betAt = (betIndex: number): WagerTransactionRequest => {
    const bet = bets[betIndex];
    if (bet === undefined) {
      throw new RangeError(`no bet at ${String(betIndex)}`);
    }
    return bet;
  };
  const referenceOf = (betIndex: number) => ({
    wallet,
    roundId: betAt(betIndex).body.roundId,
    referenceExternalTransactionId: betAt(betIndex).body.externalTransactionId,
  });
  const wins = Array.from({ length: WINS_PER_WALLET }, (_, betIndex) =>
    winCommand({ ...referenceOf(betIndex), amount: toDecimal(winCents(walletIndex, betIndex)) }),
  );
  const losses = Array.from({ length: LOSSES_PER_WALLET }, (_, offset) => {
    const betIndex = WINS_PER_WALLET + offset;
    return lossCommand({ ...referenceOf(betIndex), amount: betAt(betIndex).body.money.amount });
  });
  const refundIndex = WINS_PER_WALLET + LOSSES_PER_WALLET;
  const rollbackIndex = refundIndex + 1;
  const refund = refundCommand({
    ...referenceOf(refundIndex),
    amount: betAt(refundIndex).body.money.amount,
  });
  const rollback = rollbackCommand({
    ...referenceOf(rollbackIndex),
    amount: betAt(rollbackIndex).body.money.amount,
  });
  const totalBets = bets.reduce((sum, _, betIndex) => sum + betCents(walletIndex, betIndex), 0n);
  const totalWins = wins.reduce((sum, _, betIndex) => sum + winCents(walletIndex, betIndex), 0n);
  const reversed = betCents(walletIndex, refundIndex) + betCents(walletIndex, rollbackIndex);
  return {
    wallet,
    requests: [...wins, ...losses, refund, rollback, ...bets],
    expectedBalanceCents: INITIAL_BALANCE_CENTS - totalBets + totalWins + reversed,
    expectedWalletEntries: BETS_PER_WALLET + WINS_PER_WALLET + 2,
  };
};

const interleave = (plans: readonly WalletPlan[]): WagerTransactionRequest[] =>
  Array.from({ length: OPERATIONS_PER_WALLET }, (_, position) =>
    plans.flatMap((plan) => {
      const request = plan.requests[position];
      return request === undefined ? [] : [request];
    }),
  ).flat();

const createWallets = (apis: SpawnedInstances, operatorToken: string): Promise<TestWallet[]> =>
  Promise.all(
    Array.from({ length: WALLET_COUNT }, (_, index) =>
      createWalletViaApi(apis.instance(index % API_COUNT).baseUrl, operatorToken),
    ),
  );

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

const submitAll = (
  apis: SpawnedInstances,
  providerToken: string,
  requests: readonly WagerTransactionRequest[],
): Promise<number[]> =>
  Promise.all(
    requests.map((request, index) =>
      submitWithRetry(apis.instance(index % API_COUNT).baseUrl, providerToken, request),
    ),
  );

const contendedCount = async (baseUrl: string): Promise<number> => {
  const response = await fetch(`${baseUrl}/metrics`);
  const body = await response.text();
  return body
    .split('\n')
    .map((line) => CONTENDED_SERIES.exec(line))
    .filter((match) => match?.[1]?.includes('type="contended"') === true)
    .reduce((sum, match) => sum + Number(match?.[2] ?? '0'), 0);
};

const totalContended = async (apis: SpawnedInstances): Promise<number> => {
  const counts = await Promise.all(
    apis.instances.map((instance) => contendedCount(instance.baseUrl)),
  );
  return counts.reduce((sum, count) => sum + count, 0);
};

const unsettledCount = async (databaseUrl: string): Promise<number> => {
  const rows = await queryRows(
    databaseUrl,
    "SELECT count(*)::int AS open FROM wager_transactions WHERE status = 'PENDING_REFERENCE'",
  );
  return Number(rows[0]?.open ?? -1);
};

const walletState = async (
  databaseUrl: string,
  walletIds: readonly string[],
): Promise<Record<string, unknown>[]> =>
  queryRows(
    databaseUrl,
    `SELECT w.id, w.balance::text AS balance,
            (SELECT count(*)::int FROM wallet_ledger_entries e WHERE e.wallet_id = w.id) AS entries,
            (SELECT count(*)::int FROM wager_transactions t
              WHERE t.wallet_id = w.id AND t.status = 'PROCESSED' AND t.kind <> 'OPENING') AS processed
       FROM wallets w
      WHERE w.id = ANY($1::uuid[])
      ORDER BY w.id`,
    [walletIds],
  );

const stopAll = async (groups: readonly SpawnedInstances[]): Promise<void> => {
  await Promise.all(groups.map((group) => group.stop()));
};

describe('parallel wallets', () => {
  it('lands every wallet on its expected balance under 20 x 25 mixed parallel operations', async () => {
    const { database, issuer, env } = await prepareEnvironment();
    const [apis, schedulers] = await Promise.all([
      spawnInstances({ role: 'api', count: API_COUNT, env }),
      spawnInstances({ role: 'scheduler', count: 1, env }),
    ]);
    try {
      const operatorToken = await issuer.token({ role: 'operator' });
      const providerToken = await issuer.token({ role: 'provider', providerId: TEST_PROVIDER_ID });
      const wallets = await createWallets(apis, operatorToken);
      const plans = wallets.map((wallet, index) => planFor(wallet, index));
      const requests = interleave(plans);
      expect(requests).toHaveLength(WALLET_COUNT * OPERATIONS_PER_WALLET);

      const statuses = await submitAll(apis, providerToken, requests);

      expect(statuses.filter((status) => status !== 200 && status !== 202)).toEqual([]);
      await waitFor(async () => (await unsettledCount(database.appUrl)) === 0, SETTLE_WAIT);
      const sortedPlans = [...plans].sort((left, right) =>
        left.wallet.id.localeCompare(right.wallet.id),
      );
      expect(
        await walletState(
          database.appUrl,
          plans.map((plan) => plan.wallet.id),
        ),
      ).toEqual(
        sortedPlans.map((plan) => ({
          id: plan.wallet.id,
          balance: toDecimal(plan.expectedBalanceCents),
          entries: plan.expectedWalletEntries + 1,
          processed: OPERATIONS_PER_WALLET,
        })),
      );
    } finally {
      await stopAll([apis, schedulers]);
      await issuer.stop();
    }
  });

  it('records no contended lock when 20 wallets take one parallel operation each', async () => {
    const { database, issuer, env } = await prepareEnvironment();
    const apis = await spawnInstances({ role: 'api', count: API_COUNT, env });
    try {
      const operatorToken = await issuer.token({ role: 'operator' });
      const providerToken = await issuer.token({ role: 'provider', providerId: TEST_PROVIDER_ID });
      const wallets = await createWallets(apis, operatorToken);
      const requests = wallets.map((wallet, index) =>
        betCommand({ wallet, amount: toDecimal(betCents(index, 0)) }),
      );
      const before = await totalContended(apis);

      const statuses = await submitAll(apis, providerToken, requests);

      expect(statuses).toEqual(requests.map(() => 200));
      expect((await totalContended(apis)) - before).toBe(0);
      const state = await walletState(
        database.appUrl,
        wallets.map((wallet) => wallet.id),
      );
      expect(state.map((row) => row.processed)).toEqual(wallets.map(() => 1));
    } finally {
      await apis.stop();
      await issuer.stop();
    }
  });
});
