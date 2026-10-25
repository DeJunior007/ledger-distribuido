import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { FAULT_KILL_EXIT_CODE, NO_FAULT_ENV, faultEnv } from '@test/support/fault-env';
import {
  betCommand,
  createWalletViaApi,
  submitViaApi,
  toMessageData,
  winCommand,
} from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import { spawnInstances } from '@test/support/spawn-instances';
import type { SpawnedInstances } from '@test/support/spawn-instances';
import { buildEnvelope, createTestSqsClient, publishEnvelope } from '@test/support/sqs';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID, TestIssuer } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';
import type { TestQueues } from '@test/support/test-queues';

const CRASH_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 150_000;
const PROVIDER_TOKEN = { role: 'provider', providerId: TEST_PROVIDER_ID } as const;

interface ProcessEnvironment {
  readonly database: TestDatabase;
  readonly queues: TestQueues;
  readonly issuer: TestIssuer;
  readonly env: Readonly<Record<string, string>>;
}

interface StateSnapshot {
  readonly transactions: number;
  readonly ledgerEntries: number;
  readonly idempotencyRecords: number;
  readonly inboxMessages: number;
  readonly outboxMessages: number;
  readonly pendingRetries: number;
  readonly wallet: { readonly balance: string; readonly version: number } | undefined;
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

const snapshot = async (database: TestDatabase, walletId: string): Promise<StateSnapshot> => {
  const [counts] = await queryRows(
    database.superuserUrl,
    `SELECT (SELECT count(*)::int FROM wager_transactions) AS transactions,
            (SELECT count(*)::int FROM ledger_entries) AS "ledgerEntries",
            (SELECT count(*)::int FROM idempotency_records) AS "idempotencyRecords",
            (SELECT count(*)::int FROM inbox_messages) AS "inboxMessages",
            (SELECT count(*)::int FROM outbox_messages) AS "outboxMessages",
            (SELECT count(*)::int FROM pending_reference_retries) AS "pendingRetries"`,
  );
  const [wallet] = await queryRows(
    database.superuserUrl,
    'SELECT balance::text AS balance, version FROM wallets WHERE id = $1',
    [walletId],
  );
  return {
    transactions: Number(counts?.transactions),
    ledgerEntries: Number(counts?.ledgerEntries),
    idempotencyRecords: Number(counts?.idempotencyRecords),
    inboxMessages: Number(counts?.inboxMessages),
    outboxMessages: Number(counts?.outboxMessages),
    pendingRetries: Number(counts?.pendingRetries),
    wallet:
      wallet === undefined
        ? undefined
        : { balance: String(wallet.balance), version: Number(wallet.version) },
  };
};

const transactionsByExternalId = (
  database: TestDatabase,
  externalTransactionId: string,
): Promise<Record<string, unknown>[]> =>
  queryRows(
    database.superuserUrl,
    `SELECT t.id, t.status,
            (SELECT count(*)::int FROM ledger_entries e WHERE e.transaction_id = t.id) AS entries
       FROM wager_transactions t
      WHERE t.external_transaction_id = $1`,
    [externalTransactionId],
  );

const requestFailure = (response: Promise<Response>): Promise<unknown> =>
  response.then(
    async (received) => {
      await received.arrayBuffer();
      return received.status;
    },
    (reason: unknown) => reason,
  );

const jsonOf = async (response: Response): Promise<Record<string, unknown>> => {
  const body: unknown = await response.json();
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? Object.fromEntries(Object.entries(body))
    : {};
};

const stopAll = async (groups: readonly SpawnedInstances[]): Promise<void> => {
  await Promise.all(groups.map((group) => group.stop()));
};

const openWallet = async (baseUrl: string, issuer: TestIssuer): Promise<TestWallet> =>
  createWalletViaApi(baseUrl, await issuer.token({ role: 'operator' }));

describe('atomicity under crashes', () => {
  it(
    'leaves nothing behind when the api dies before the commit',
    async () => {
      const { database, issuer, env } = await prepareEnvironment();
      const apis = await spawnInstances({
        role: 'api',
        count: 1,
        env: { ...env, ...faultEnv('api.before_commit') },
      });
      try {
        const api = apis.instance(0);
        const wallet = await openWallet(api.baseUrl, issuer);
        const before = await snapshot(database, wallet.id);
        const request = betCommand({ wallet });

        const failure = await requestFailure(
          submitViaApi(api.baseUrl, await issuer.token(PROVIDER_TOKEN), request),
        );

        expect(failure).toBeInstanceOf(Error);
        expect(await api.waitForExit(CRASH_TIMEOUT_MS)).toBe(FAULT_KILL_EXIT_CODE);
        expect(
          await transactionsByExternalId(database, request.body.externalTransactionId),
        ).toEqual([]);
        expect(await snapshot(database, wallet.id)).toEqual(before);
        expect(before.wallet).toEqual({ balance: '1000.00', version: 1 });
      } finally {
        await apis.stop();
        await issuer.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'leaves nothing behind when the consumer dies before the commit',
    async () => {
      const { database, queues, issuer, env } = await prepareEnvironment();
      const sqs = createTestSqsClient();
      const apis = await spawnInstances({ role: 'api', count: 1, env });
      const consumers = await spawnInstances({
        role: 'consumer',
        count: 1,
        env: { ...env, ...faultEnv('consumer.before_commit') },
      });
      try {
        const consumer = consumers.instance(0);
        const wallet = await openWallet(apis.instance(0).baseUrl, issuer);
        const before = await snapshot(database, wallet.id);
        const request = betCommand({ wallet });

        await publishEnvelope(
          sqs,
          queues.urls.wagerTransactions,
          buildEnvelope({ data: toMessageData(request) }),
        );

        expect(await consumer.waitForExit(CRASH_TIMEOUT_MS)).toBe(FAULT_KILL_EXIT_CODE);
        expect(
          await transactionsByExternalId(database, request.body.externalTransactionId),
        ).toEqual([]);
        expect(await snapshot(database, wallet.id)).toEqual(before);
        expect(before.wallet).toEqual({ balance: '1000.00', version: 1 });
      } finally {
        sqs.destroy();
        await stopAll([consumers, apis]);
        await issuer.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps the effect when the api dies after the commit and replays the retry',
    async () => {
      const { database, issuer, env } = await prepareEnvironment();
      const apis = await spawnInstances({
        role: 'api',
        count: 1,
        env: { ...env, ...faultEnv('api.after_commit_before_response') },
      });
      try {
        const api = apis.instance(0);
        const wallet = await openWallet(api.baseUrl, issuer);
        const request = betCommand({ wallet });
        const providerToken = await issuer.token(PROVIDER_TOKEN);

        const failure = await requestFailure(submitViaApi(api.baseUrl, providerToken, request));

        expect(failure).toBeInstanceOf(Error);
        expect(await api.waitForExit(CRASH_TIMEOUT_MS)).toBe(FAULT_KILL_EXIT_CODE);
        const committed = await transactionsByExternalId(
          database,
          request.body.externalTransactionId,
        );
        expect(committed).toEqual([{ id: expect.any(String), status: 'PROCESSED', entries: 2 }]);
        const afterCrash = await snapshot(database, wallet.id);
        expect(afterCrash.wallet).toEqual({ balance: '990.00', version: 2 });

        await api.restart({ env: NO_FAULT_ENV });
        const retry = await submitViaApi(api.baseUrl, providerToken, request);

        expect(retry.status).toBe(200);
        const body = await jsonOf(retry);
        expect(body.status).toBe('PROCESSED');
        expect(body.idempotentReplay).toBe(true);
        expect(body.transactionId).toBe(committed[0]?.id);
        expect(await snapshot(database, wallet.id)).toEqual(afterCrash);
      } finally {
        await apis.stop();
        await issuer.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps the effect when the scheduler dies after the commit and replays the retry',
    async () => {
      const { database, issuer, env } = await prepareEnvironment();
      const apis = await spawnInstances({ role: 'api', count: 1, env });
      let schedulers: SpawnedInstances | undefined;
      try {
        const api = apis.instance(0);
        const wallet = await openWallet(api.baseUrl, issuer);
        const providerToken = await issuer.token(PROVIDER_TOKEN);
        const bet = betCommand({ wallet });
        const win = winCommand({
          wallet,
          amount: '20.00',
          roundId: bet.body.roundId,
          referenceExternalTransactionId: bet.body.externalTransactionId,
        });
        const pending = await submitViaApi(api.baseUrl, providerToken, win);
        expect(pending.status).toBe(202);
        const pendingBody = await jsonOf(pending);
        expect(pendingBody.status).toBe('PENDING_REFERENCE');
        schedulers = await spawnInstances({
          role: 'scheduler',
          count: 1,
          env: { ...env, ...faultEnv('scheduler.after_commit') },
        });
        const placed = await submitViaApi(api.baseUrl, providerToken, bet);
        expect(placed.status).toBe(200);
        await placed.arrayBuffer();

        expect(await schedulers.instance(0).waitForExit(CRASH_TIMEOUT_MS)).toBe(
          FAULT_KILL_EXIT_CODE,
        );
        const resolved = await transactionsByExternalId(database, win.body.externalTransactionId);
        expect(resolved).toEqual([
          { id: pendingBody.transactionId, status: 'PROCESSED', entries: 2 },
        ]);
        expect(
          await queryRows(
            database.superuserUrl,
            'SELECT resolved_at IS NOT NULL AS resolved FROM pending_reference_retries WHERE transaction_id = $1',
            [pendingBody.transactionId],
          ),
        ).toEqual([{ resolved: true }]);
        const afterCrash = await snapshot(database, wallet.id);
        expect(afterCrash.wallet).toEqual({ balance: '1010.00', version: 3 });

        const retry = await submitViaApi(api.baseUrl, providerToken, win);

        expect(retry.status).toBe(200);
        const body = await jsonOf(retry);
        expect(body.status).toBe('PROCESSED');
        expect(body.idempotentReplay).toBe(true);
        expect(body.transactionId).toBe(pendingBody.transactionId);
        expect(await snapshot(database, wallet.id)).toEqual(afterCrash);
      } finally {
        await stopAll(schedulers === undefined ? [apis] : [schedulers, apis]);
        await issuer.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
