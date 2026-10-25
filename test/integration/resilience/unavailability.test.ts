import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { pause, unpause } from '@test/support/containers';
import type { ContainerName } from '@test/support/containers';
import {
  betCommand,
  createWalletViaApi,
  submitViaApi,
  toMessageData,
} from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import { spawnInstances } from '@test/support/spawn-instances';
import type { LogEntry, SpawnedInstance, SpawnedInstances } from '@test/support/spawn-instances';
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

const WALLET_COUNT = 3;
const MESSAGES_PER_WALLET = 4;
const WAGERS_PER_WALLET = 4;
const TEST_TIMEOUT_MS = 170_000;
const BREAKER_LOG_TIMEOUT_MS = 30_000;
const QUIET_WINDOW_MS = 12_000;
const IN_FLIGHT_SETTLE_MS = 8_000;
const OUTAGE_WAIT = { timeoutMs: 30_000, intervalMs: 200 } as const;
const DRAIN_WAIT = { timeoutMs: 90_000, intervalMs: 200 } as const;
const PROVIDER_TOKEN = { role: 'provider', providerId: TEST_PROVIDER_ID } as const;
const BET_AMOUNT = 10n;
const INITIAL_BALANCE = 1000n;
const OPENED = 'circuit breaker opened';
const CLOSED = 'circuit breaker closed';
const DEFERRED = 'message processing deferred';

interface ProcessEnvironment {
  readonly database: TestDatabase;
  readonly queues: TestQueues;
  readonly issuer: TestIssuer;
  readonly env: Readonly<Record<string, string>>;
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

const queryRows = async (databaseUrl: string, sql: string): Promise<Record<string, unknown>[]> => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<Record<string, unknown>>(sql);
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

const debitedBalances = (
  wallets: readonly TestWallet[],
  perWallet: number,
): Record<string, string> =>
  Object.fromEntries(
    wallets.map((wallet) => [
      wallet.id,
      `${String(INITIAL_BALANCE - BET_AMOUNT * BigInt(perWallet))}.00`,
    ]),
  );

const betSummary = async (database: TestDatabase): Promise<Record<string, unknown> | undefined> => {
  const [summary] = await queryRows(
    database.superuserUrl,
    `SELECT (SELECT count(*)::int FROM wager_transactions
              WHERE kind = 'BET' AND status = 'PROCESSED') AS processed,
            (SELECT count(*)::int FROM wager_transactions WHERE kind = 'BET') AS transactions,
            (SELECT count(DISTINCT external_transaction_id)::int FROM wager_transactions
              WHERE kind = 'BET') AS distinct,
            (SELECT count(*)::int FROM ledger_entries e
               JOIN wager_transactions t ON t.id = e.transaction_id
              WHERE t.kind = 'BET') AS entries`,
  );
  return summary;
};

const processedBets = (database: TestDatabase): Promise<number> =>
  countOf(
    database,
    "SELECT count(*)::int AS count FROM wager_transactions WHERE kind = 'BET' AND status = 'PROCESSED'",
  );

const isMessage =
  (message: string, component?: string) =>
  (entry: LogEntry): boolean =>
    entry.message === message && (component === undefined || entry.component === component);

const linesOf = (instance: SpawnedInstance): number => instance.logs().length;

const deferredAttempts = (instance: SpawnedInstance): unknown[] =>
  instance
    .logs()
    .filter(isMessage(DEFERRED))
    .map((entry) => entry.attempt);

const openWallets = async (baseUrl: string, issuer: TestIssuer): Promise<TestWallet[]> => {
  const operatorToken = await issuer.token({ role: 'operator' });
  return Promise.all(
    Array.from({ length: WALLET_COUNT }, () => createWalletViaApi(baseUrl, operatorToken)),
  );
};

const statusOf = async (response: Response): Promise<number> => {
  await response.arrayBuffer();
  return response.status;
};

const readiness = async (baseUrl: string): Promise<number> =>
  statusOf(await fetch(`${baseUrl}/health/ready`));

const withPaused = async (name: ContainerName, during: () => Promise<void>): Promise<void> => {
  await pause(name);
  try {
    await during();
  } finally {
    await unpause(name);
  }
};

const isSpawned = (group: SpawnedInstances | undefined): group is SpawnedInstances =>
  group !== undefined;

const stopAll = async (groups: readonly (SpawnedInstances | undefined)[]): Promise<void> => {
  await Promise.all(groups.filter(isSpawned).map((group) => group.stop()));
};

describe('real unavailability', () => {
  it(
    'answers 503 and holds the consumer while postgres is paused, then concludes everything',
    async () => {
      const { database, queues, issuer, env } = await prepareEnvironment();
      const sqs = createTestSqsClient();
      let apis: SpawnedInstances | undefined;
      let consumers: SpawnedInstances | undefined;
      try {
        apis = await spawnInstances({ role: 'api', count: 1, env });
        consumers = await spawnInstances({ role: 'consumer', count: 1, env });
        const api = apis.instance(0);
        const consumer = consumers.instance(0);
        const providerToken = await issuer.token(PROVIDER_TOKEN);
        const wallets = await openWallets(api.baseUrl, issuer);
        const queued = wallets.flatMap((wallet) =>
          Array.from({ length: MESSAGES_PER_WALLET }, () => betCommand({ wallet })),
        );
        const directWallet = await createWalletViaApi(
          api.baseUrl,
          await issuer.token({ role: 'operator' }),
        );
        const direct = betCommand({ wallet: directWallet });
        const consumerStart = linesOf(consumer);
        let outage: Response | undefined;
        let readyDuringOutage = 0;
        let attemptsDuringOutage: unknown[] = [];

        await withPaused('postgres', async () => {
          await Promise.all(
            queued.map((request) =>
              publishEnvelope(
                sqs,
                queues.urls.wagerTransactions,
                buildEnvelope({ data: toMessageData(request) }),
              ),
            ),
          );
          outage = await submitViaApi(api.baseUrl, providerToken, direct);
          await outage.arrayBuffer();
          readyDuringOutage = await readiness(api.baseUrl);
          await consumer.waitForLog(isMessage(OPENED, 'consumer'), {
            timeoutMs: BREAKER_LOG_TIMEOUT_MS,
            fromLine: consumerStart,
          });
          await Bun.sleep(IN_FLIGHT_SETTLE_MS);
          const afterOpen = deferredAttempts(consumer).length;
          await Bun.sleep(QUIET_WINDOW_MS);
          attemptsDuringOutage = deferredAttempts(consumer);
          expect(attemptsDuringOutage.length).toBe(afterOpen);
          expect(consumer.logs().slice(consumerStart).some(isMessage(CLOSED, 'consumer'))).toBe(
            false,
          );
        });

        expect(outage?.status).toBe(503);
        expect(Number(outage?.headers.get('Retry-After'))).toBeGreaterThan(0);
        expect(readyDuringOutage).toBe(503);
        expect(attemptsDuringOutage.length).toBeGreaterThan(0);
        expect(attemptsDuringOutage.every((attempt) => attempt === 1)).toBe(true);

        await consumer.waitForLog(isMessage(CLOSED, 'consumer'), {
          timeoutMs: DRAIN_WAIT.timeoutMs,
          fromLine: consumerStart,
        });
        await waitFor(async () => (await readiness(api.baseUrl)) === 200, OUTAGE_WAIT);
        expect(await statusOf(await submitViaApi(api.baseUrl, providerToken, direct))).toBe(200);
        const total = queued.length + 1;
        await waitFor(
          async () =>
            (await processedBets(database)) === total &&
            (await countMessages(sqs, queues.urls.wagerTransactions)).total === 0,
          DRAIN_WAIT,
        );
        expect(await betSummary(database)).toEqual({
          processed: total,
          transactions: total,
          distinct: total,
          entries: total * 2,
        });
        expect(
          await countOf(
            database,
            "SELECT count(*)::int AS count FROM inbox_messages WHERE consumer_name = 'wager-transactions-consumer'",
          ),
        ).toBe(queued.length);
        expect(await balancesOf(database)).toEqual({
          ...debitedBalances(wallets, MESSAGES_PER_WALLET),
          ...debitedBalances([directWallet], 1),
        });
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
    'keeps every event while ministack is paused, then publishes and consumes them',
    async () => {
      const { database, queues, issuer, env } = await prepareEnvironment();
      const sqs = createTestSqsClient();
      let apis: SpawnedInstances | undefined;
      let outboxes: SpawnedInstances | undefined;
      let consumers: SpawnedInstances | undefined;
      let audits: SpawnedInstances | undefined;
      try {
        apis = await spawnInstances({ role: 'api', count: 1, env });
        outboxes = await spawnInstances({ role: 'outbox', count: 1, env });
        consumers = await spawnInstances({ role: 'consumer', count: 1, env });
        audits = await spawnInstances({ role: 'events-audit', count: 1, env });
        const api = apis.instance(0);
        const outbox = outboxes.instance(0);
        const consumer = consumers.instance(0);
        const providerToken = await issuer.token(PROVIDER_TOKEN);
        const wallets = await openWallets(api.baseUrl, issuer);
        const outboxStart = linesOf(outbox);
        const consumerStart = linesOf(consumer);
        const published = (): Promise<number> =>
          countOf(
            database,
            'SELECT count(*)::int AS count FROM outbox_messages WHERE published_at IS NOT NULL',
          );
        const publishedBefore = await published();
        let total = 0;
        let unpublishedDuringOutage = 0;

        await withPaused('ministack', async () => {
          await Promise.all(
            wallets.map(async (wallet) => {
              for (let index = 0; index < WAGERS_PER_WALLET; index += 1) {
                const response = await submitViaApi(
                  api.baseUrl,
                  providerToken,
                  betCommand({ wallet }),
                );
                expect(await statusOf(response)).toBe(200);
              }
            }),
          );
          await outbox.waitForLog(isMessage(OPENED, 'outbox'), {
            timeoutMs: BREAKER_LOG_TIMEOUT_MS,
            fromLine: outboxStart,
          });
          await consumer.waitForLog(isMessage(OPENED, 'consumer'), {
            timeoutMs: BREAKER_LOG_TIMEOUT_MS,
            fromLine: consumerStart,
          });
          total = await countOf(database, 'SELECT count(*)::int AS count FROM outbox_messages');
          unpublishedDuringOutage = total - (await published());
          expect(await published()).toBe(publishedBefore);
        });

        expect(unpublishedDuringOutage).toBeGreaterThanOrEqual(WALLET_COUNT * WAGERS_PER_WALLET);
        await outbox.waitForLog(isMessage(CLOSED, 'outbox'), {
          timeoutMs: DRAIN_WAIT.timeoutMs,
          fromLine: outboxStart,
        });
        await waitFor(async () => (await published()) === total, DRAIN_WAIT);
        const eventIds = (
          await queryRows(
            database.superuserUrl,
            "SELECT payload->>'eventId' AS event_id FROM outbox_messages ORDER BY 1",
          )
        ).map((row) => String(row.event_id));
        const audited = (): Promise<Record<string, unknown>[]> =>
          queryRows(
            database.superuserUrl,
            `SELECT message_id FROM inbox_messages
              WHERE consumer_name = 'wallet-events-audit' ORDER BY message_id`,
          );
        await waitFor(async () => (await audited()).length === total, DRAIN_WAIT);
        expect((await audited()).map((row) => String(row.message_id))).toEqual(eventIds);
        expect(
          await countOf(
            database,
            'SELECT count(*)::int AS count FROM outbox_messages WHERE parked_at IS NOT NULL',
          ),
        ).toBe(0);

        await consumer.waitForLog(isMessage(CLOSED, 'consumer'), {
          timeoutMs: DRAIN_WAIT.timeoutMs,
          fromLine: consumerStart,
        });
        const queued = wallets.map((wallet) => betCommand({ wallet }));
        await Promise.all(
          queued.map((request) =>
            publishEnvelope(
              sqs,
              queues.urls.wagerTransactions,
              buildEnvelope({ data: toMessageData(request) }),
            ),
          ),
        );
        const bets = WALLET_COUNT * WAGERS_PER_WALLET + queued.length;
        await waitFor(
          async () =>
            (await processedBets(database)) === bets &&
            (await countMessages(sqs, queues.urls.wagerTransactions)).total === 0,
          DRAIN_WAIT,
        );
        expect(await betSummary(database)).toEqual({
          processed: bets,
          transactions: bets,
          distinct: bets,
          entries: bets * 2,
        });
        expect(await balancesOf(database)).toEqual(debitedBalances(wallets, WAGERS_PER_WALLET + 1));
        expect((await countMessages(sqs, queues.urls.wagerTransactionsDlq)).total).toBe(0);
      } finally {
        sqs.destroy();
        await stopAll([audits, consumers, outboxes, apis]);
        await issuer.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
