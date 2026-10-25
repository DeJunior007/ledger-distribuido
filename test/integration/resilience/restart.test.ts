import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import {
  betCommand,
  createWalletViaApi,
  submitViaApi,
  toMessageData,
  winCommand,
} from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import { SIGKILL_EXIT_CODE, spawnInstances } from '@test/support/spawn-instances';
import type { SpawnedInstance, SpawnedInstances } from '@test/support/spawn-instances';
import {
  buildEnvelope,
  countMessages,
  createTestSqsClient,
  publishEnvelope,
} from '@test/support/sqs';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID, TestIssuer } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';
import type { TestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

const WALLET_COUNT = 4;
const MESSAGES_PER_WALLET = 25;
const WAGERS_PER_WALLET = 25;
const PENDING_PER_WALLET = 10;
const TEST_TIMEOUT_MS = 170_000;
const PROGRESS_WAIT = { timeoutMs: 60_000, intervalMs: 10 } as const;
const DRAIN_WAIT = { timeoutMs: 90_000, intervalMs: 200 } as const;
const PROVIDER_TOKEN = { role: 'provider', providerId: TEST_PROVIDER_ID } as const;
const BET_AMOUNT = 10n;
const WIN_AMOUNT = 20n;
const INITIAL_BALANCE = 1000n;

interface ProcessEnvironment {
  readonly database: TestDatabase;
  readonly queues: TestQueues;
  readonly issuer: TestIssuer;
  readonly env: Readonly<Record<string, string>>;
}

interface KillOutcome {
  readonly exitCode: number;
  readonly progressAtKill: number;
}

const prepareEnvironment = async (): Promise<ProcessEnvironment> => {
  const database = await createTestDatabase();
  const queues = await createTestQueues();
  const issuer = await TestIssuer.start();
  return {
    database,
    queues,
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

const countOf = async (database: TestDatabase, sql: string): Promise<number> => {
  const [row] = await queryRows(database.superuserUrl, sql);
  return Number(row?.count);
};

const balancesOf = async (database: TestDatabase): Promise<Record<string, string>> => {
  const rows = await queryRows(
    database.superuserUrl,
    'SELECT id, balance::text AS balance FROM wallets',
  );
  return Object.fromEntries(rows.map((row) => [String(row.id), String(row.balance)]));
};

const expectedBalances = (
  wallets: readonly TestWallet[],
  delta: bigint,
  perWallet: number,
): Record<string, string> =>
  Object.fromEntries(
    wallets.map((wallet) => [
      wallet.id,
      `${String(INITIAL_BALANCE + delta * BigInt(perWallet))}.00`,
    ]),
  );

const unbalancedTransactions = (database: TestDatabase): Promise<number> =>
  countOf(
    database,
    `SELECT count(*)::int AS count FROM wager_transactions t
      WHERE t.status = 'PROCESSED'
        AND (SELECT count(*) FROM ledger_entries e WHERE e.transaction_id = t.id) <> 2`,
  );

const killMidBatch = async (
  instance: SpawnedInstance,
  progress: () => Promise<number>,
): Promise<KillOutcome> => {
  await waitFor(async () => (await progress()) > 0, PROGRESS_WAIT);
  const exitCode = await instance.kill('SIGKILL');
  return { exitCode, progressAtKill: await progress() };
};

const openWallets = async (baseUrl: string, issuer: TestIssuer): Promise<TestWallet[]> => {
  const operatorToken = await issuer.token({ role: 'operator' });
  return Promise.all(
    Array.from({ length: WALLET_COUNT }, () => createWalletViaApi(baseUrl, operatorToken)),
  );
};

const submitAccepted = async (
  baseUrl: string,
  token: string,
  request: ReturnType<typeof betCommand>,
  status: number,
): Promise<void> => {
  const response = await submitViaApi(baseUrl, token, request);
  await response.arrayBuffer();
  expect(response.status).toBe(status);
};

const isSpawned = (group: SpawnedInstances | undefined): group is SpawnedInstances =>
  group !== undefined;

const stopAll = async (groups: readonly SpawnedInstances[]): Promise<void> => {
  await Promise.all(groups.map((group) => group.stop()));
};

describe('restart recovery', () => {
  it(
    'processes every queued wager exactly once when the consumer is killed mid-batch',
    async () => {
      const { database, queues, issuer, env } = await prepareEnvironment();
      const sqs = createTestSqsClient();
      const apis = await spawnInstances({ role: 'api', count: 1, env });
      const consumers = await spawnInstances({ role: 'consumer', count: 1, env });
      try {
        const consumer = consumers.instance(0);
        const wallets = await openWallets(apis.instance(0).baseUrl, issuer);
        const requests = wallets.flatMap((wallet) =>
          Array.from({ length: MESSAGES_PER_WALLET }, () => betCommand({ wallet })),
        );
        const total = requests.length;
        await Promise.all(
          requests.map((request) =>
            publishEnvelope(
              sqs,
              queues.urls.wagerTransactions,
              buildEnvelope({ data: toMessageData(request) }),
            ),
          ),
        );
        const processed = (): Promise<number> =>
          countOf(
            database,
            "SELECT count(*)::int AS count FROM wager_transactions WHERE kind = 'BET'",
          );

        const killed = await killMidBatch(consumer, processed);

        expect(killed.exitCode).toBe(SIGKILL_EXIT_CODE);
        expect(killed.progressAtKill).toBeGreaterThan(0);
        expect(killed.progressAtKill).toBeLessThan(total);
        await consumer.restart();
        await waitFor(
          async () =>
            (await processed()) === total &&
            (await countMessages(sqs, queues.urls.wagerTransactions)).total === 0,
          DRAIN_WAIT,
        );
        const [summary] = await queryRows(
          database.superuserUrl,
          `SELECT (SELECT count(*)::int FROM wager_transactions
                    WHERE kind = 'BET' AND status = 'PROCESSED') AS processed,
                  (SELECT count(DISTINCT external_transaction_id)::int FROM wager_transactions
                    WHERE kind = 'BET') AS distinct,
                  (SELECT count(*)::int FROM ledger_entries e
                     JOIN wager_transactions t ON t.id = e.transaction_id
                    WHERE t.kind = 'BET') AS entries,
                  (SELECT count(*)::int FROM inbox_messages
                    WHERE consumer_name = 'wager-transactions-consumer') AS inbox,
                  (SELECT count(*)::int FROM idempotency_records r
                     JOIN wager_transactions t ON t.id = r.transaction_id
                    WHERE t.kind = 'BET') AS records`,
        );
        expect(summary).toEqual({
          processed: total,
          distinct: total,
          entries: total * 2,
          inbox: total,
          records: total,
        });
        expect(await unbalancedTransactions(database)).toBe(0);
        expect(await balancesOf(database)).toEqual(
          expectedBalances(wallets, -BET_AMOUNT, MESSAGES_PER_WALLET),
        );
        expect((await countMessages(sqs, queues.urls.wagerTransactionsDlq)).total).toBe(0);
      } finally {
        sqs.destroy();
        await stopAll([consumers, apis]);
        await issuer.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'publishes every outbox event once when the outbox is killed mid-batch',
    async () => {
      const { database, queues, issuer, env } = await prepareEnvironment();
      const sqs = createTestSqsClient();
      const apis = await spawnInstances({ role: 'api', count: 1, env });
      let outboxes: SpawnedInstances | undefined;
      let audits: SpawnedInstances | undefined;
      try {
        const baseUrl = apis.instance(0).baseUrl;
        const providerToken = await issuer.token(PROVIDER_TOKEN);
        const wallets = await openWallets(baseUrl, issuer);
        await Promise.all(
          wallets.map(async (wallet) => {
            for (let index = 0; index < WAGERS_PER_WALLET; index += 1) {
              await submitAccepted(baseUrl, providerToken, betCommand({ wallet }), 200);
            }
          }),
        );
        const eventIds = (
          await queryRows(
            database.superuserUrl,
            "SELECT payload->>'eventId' AS event_id FROM outbox_messages ORDER BY 1",
          )
        ).map((row) => String(row.event_id));
        const total = eventIds.length;
        expect(total).toBeGreaterThan(0);
        const published = (): Promise<number> =>
          countOf(
            database,
            'SELECT count(*)::int AS count FROM outbox_messages WHERE published_at IS NOT NULL',
          );

        outboxes = await spawnInstances({
          role: 'outbox',
          count: 1,
          env: { ...env, OUTBOX_BATCH_SIZE: '1' },
        });
        const outbox = outboxes.instance(0);
        const killed = await killMidBatch(outbox, published);

        expect(killed.exitCode).toBe(SIGKILL_EXIT_CODE);
        expect(killed.progressAtKill).toBeGreaterThan(0);
        expect(killed.progressAtKill).toBeLessThan(total);
        await outbox.restart();
        await waitFor(async () => (await published()) === total, DRAIN_WAIT);
        expect((await countMessages(sqs, queues.urls.walletEvents)).total).toBe(total);
        expect(
          await countOf(
            database,
            'SELECT count(*)::int AS count FROM outbox_messages WHERE parked_at IS NOT NULL',
          ),
        ).toBe(0);
        audits = await spawnInstances({ role: 'events-audit', count: 1, env });
        const audited = (): Promise<number> =>
          countOf(
            database,
            "SELECT count(*)::int AS count FROM inbox_messages WHERE consumer_name = 'wallet-events-audit'",
          );
        await waitFor(
          async () =>
            (await audited()) === total &&
            (await countMessages(sqs, queues.urls.walletEvents)).total === 0,
          DRAIN_WAIT,
        );
        const auditedIds = (
          await queryRows(
            database.superuserUrl,
            `SELECT message_id FROM inbox_messages
              WHERE consumer_name = 'wallet-events-audit' ORDER BY message_id`,
          )
        ).map((row) => String(row.message_id));
        expect(auditedIds).toEqual(eventIds);
      } finally {
        sqs.destroy();
        await stopAll([audits, outboxes, apis].filter(isSpawned));
        await issuer.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'resolves every pending reference once when the scheduler is killed mid-batch',
    async () => {
      const { database, issuer, env } = await prepareEnvironment();
      const apis = await spawnInstances({ role: 'api', count: 1, env });
      let schedulers: SpawnedInstances | undefined;
      try {
        const baseUrl = apis.instance(0).baseUrl;
        const providerToken = await issuer.token(PROVIDER_TOKEN);
        const wallets = await openWallets(baseUrl, issuer);
        await Promise.all(
          wallets.map(async (wallet) => {
            for (let index = 0; index < PENDING_PER_WALLET; index += 1) {
              const bet = betCommand({ wallet });
              const win = winCommand({
                wallet,
                amount: `${String(WIN_AMOUNT)}.00`,
                roundId: bet.body.roundId,
                referenceExternalTransactionId: bet.body.externalTransactionId,
              });
              await submitAccepted(baseUrl, providerToken, win, 202);
              await submitAccepted(baseUrl, providerToken, bet, 200);
            }
          }),
        );
        const total = WALLET_COUNT * PENDING_PER_WALLET;
        const resolved = (): Promise<number> =>
          countOf(
            database,
            'SELECT count(*)::int AS count FROM pending_reference_retries WHERE resolved_at IS NOT NULL',
          );

        schedulers = await spawnInstances({
          role: 'scheduler',
          count: 1,
          env: { ...env, PENDING_BATCH_SIZE: '2' },
        });
        const scheduler = schedulers.instance(0);
        const killed = await killMidBatch(scheduler, resolved);

        expect(killed.exitCode).toBe(SIGKILL_EXIT_CODE);
        expect(killed.progressAtKill).toBeGreaterThan(0);
        expect(killed.progressAtKill).toBeLessThan(total);
        await scheduler.restart();
        await waitFor(async () => (await resolved()) === total, DRAIN_WAIT);
        const [summary] = await queryRows(
          database.superuserUrl,
          `SELECT (SELECT count(*)::int FROM wager_transactions
                    WHERE kind = 'WIN' AND status = 'PROCESSED') AS wins,
                  (SELECT count(*)::int FROM wager_transactions
                    WHERE kind = 'BET' AND status = 'PROCESSED') AS bets,
                  (SELECT count(*)::int FROM wager_transactions
                    WHERE kind IN ('BET', 'WIN')) AS transactions,
                  (SELECT count(*)::int FROM ledger_entries e
                     JOIN wager_transactions t ON t.id = e.transaction_id
                    WHERE t.kind IN ('BET', 'WIN')) AS entries,
                  (SELECT count(*)::int FROM pending_reference_retries) AS retries`,
        );
        expect(summary).toEqual({
          wins: total,
          bets: total,
          transactions: total * 2,
          entries: total * 4,
          retries: total,
        });
        expect(await unbalancedTransactions(database)).toBe(0);
        expect(await balancesOf(database)).toEqual(
          expectedBalances(wallets, WIN_AMOUNT - BET_AMOUNT, PENDING_PER_WALLET),
        );
      } finally {
        await stopAll(schedulers === undefined ? [apis] : [schedulers, apis]);
        await issuer.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
