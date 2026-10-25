import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Client } from 'pg';
import type { QueryResultRow } from 'pg';
import { Money } from '@domain/shared/money';
import type { WagerTransactionRequest } from '@interfaces/http/schemas/wager-transaction.schema';
import { betCommand, createWalletViaApi, toMessageData } from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import { SpawnInstancesError, spawnInstances } from '@test/support/spawn-instances';
import type { SpawnedInstance, SpawnedInstances } from '@test/support/spawn-instances';
import {
  buildEnvelope,
  countMessages,
  createTestSqsClient,
  publishEnvelope,
} from '@test/support/sqs';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TestIssuer } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';
import type { TestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

const WALLET_COUNT = 6;
const BET_AMOUNT = '1.00';
const COMMITTED_BEFORE_KILL = 60;
const READY_TIMEOUT_MS = 120_000;
const SPAWN_ATTEMPTS = 3;
const HTTP_TIMEOUT_MS = 10_000;
const HTTP_RETRY_ATTEMPTS = 5;
const CONSUMER_NAME = 'wager-transactions-consumer';
const LOAD_WAIT = { timeoutMs: 60_000, intervalMs: 50 } as const;
const SETTLE_WAIT = { timeoutMs: 120_000, intervalMs: 250 } as const;

interface HttpOperation {
  readonly request: WagerTransactionRequest;
  readonly apiIndex: number;
  status: number | undefined;
  transactionId: string | undefined;
}

interface QueueOperation {
  readonly request: WagerTransactionRequest;
  readonly messageId: string;
}

interface LoadState {
  stopped: boolean;
  readonly http: HttpOperation[];
  readonly queue: QueueOperation[];
}

interface Harness {
  readonly database: TestDatabase;
  readonly queues: TestQueues;
  readonly issuer: TestIssuer;
  readonly sqs: SQSClient;
  readonly groups: readonly SpawnedInstances[];
  readonly apis: SpawnedInstances;
  readonly providerToken: string;
}

interface StoredTransaction {
  readonly external_transaction_id: string;
  readonly id: string;
  readonly status: string;
  readonly entries: number;
  readonly processed_events: number;
}

const query = async <Row extends QueryResultRow>(
  databaseUrl: string,
  sql: string,
  params: readonly unknown[] = [],
): Promise<Row[]> => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<Row>(sql, [...params]);
    return result.rows;
  } finally {
    await client.end();
  }
};

const releaseLeases = async (databaseUrl: string): Promise<void> => {
  await query(
    databaseUrl,
    `UPDATE pending_reference_retries SET locked_until = NULL, locked_by = NULL
      WHERE resolved_at IS NULL AND locked_until IS NOT NULL`,
  );
  await query(
    databaseUrl,
    `UPDATE outbox_messages SET locked_until = NULL, locked_by = NULL
      WHERE published_at IS NULL AND locked_until IS NOT NULL`,
  );
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const transactionIdOf = (body: unknown): string | undefined =>
  isRecord(body) && typeof body.transactionId === 'string' ? body.transactionId : undefined;

const isPortTaken = (error: unknown): boolean =>
  error instanceof SpawnInstancesError && error.message.includes('EADDRINUSE');

const withPortRetry = async <T>(start: () => Promise<T>): Promise<T> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await start();
    } catch (error) {
      if (attempt >= SPAWN_ATTEMPTS || !isPortTaken(error)) {
        throw error;
      }
    }
  }
};

const startHarness = async (): Promise<Harness> => {
  const database = await createTestDatabase();
  const queues = await createTestQueues();
  const issuer = await TestIssuer.start();
  const env = { DATABASE_URL: database.appUrl, ...queues.env, ...issuer.authConfig };
  const settled = await Promise.allSettled([
    withPortRetry(() =>
      spawnInstances({ role: 'api', count: 3, env, readyTimeoutMs: READY_TIMEOUT_MS }),
    ),
    withPortRetry(() =>
      spawnInstances({ role: 'consumer', count: 3, env, readyTimeoutMs: READY_TIMEOUT_MS }),
    ),
    withPortRetry(() =>
      spawnInstances({ role: 'outbox', count: 2, env, readyTimeoutMs: READY_TIMEOUT_MS }),
    ),
    withPortRetry(() =>
      spawnInstances({ role: 'scheduler', count: 1, env, readyTimeoutMs: READY_TIMEOUT_MS }),
    ),
  ]);
  const groups = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  const failure = settled.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  const [apis] = groups;
  if (failure !== undefined || apis === undefined) {
    await Promise.all(groups.map((group) => group.stop()));
    await issuer.stop();
    throw failure?.reason;
  }
  return {
    database,
    queues,
    issuer,
    sqs: createTestSqsClient(),
    groups,
    apis,
    providerToken: await issuer.token({ role: 'provider', providerId: 'provider-a' }),
  };
};

const stopHarness = async (harness: Harness): Promise<void> => {
  harness.sqs.destroy();
  await Promise.all(harness.groups.map((group) => group.stop()));
  await harness.issuer.stop();
  await releaseLeases(harness.database.superuserUrl);
};

const everyInstance = (harness: Harness): SpawnedInstance[] =>
  harness.groups.flatMap((group) => [...group.instances]);

const createWallets = async (harness: Harness): Promise<TestWallet[]> => {
  const operatorToken = await harness.issuer.token({ role: 'operator' });
  return Promise.all(
    Array.from({ length: WALLET_COUNT }, (_, index) =>
      createWalletViaApi(
        harness.apis.instance(index % harness.apis.instances.length).baseUrl,
        operatorToken,
      ),
    ),
  );
};

const submitHttp = async (harness: Harness, target: HttpOperation): Promise<void> => {
  try {
    const response = await fetch(
      `${harness.apis.instance(target.apiIndex).baseUrl}/wagering/transactions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${harness.providerToken}`,
          'Idempotency-Key': target.request.idempotencyKey,
        },
        body: JSON.stringify(target.request.body),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      },
    );
    const body: unknown = await response.json();
    target.status = response.status;
    target.transactionId = transactionIdOf(body);
  } catch {
    target.status = undefined;
    target.transactionId = undefined;
  }
};

const publishQueue = async (harness: Harness, target: QueueOperation): Promise<void> => {
  await publishEnvelope(
    harness.sqs,
    harness.queues.urls.wagerTransactions,
    buildEnvelope({ messageId: target.messageId, data: toMessageData(target.request) }),
  );
};

const runLoad = async (
  harness: Harness,
  wallets: readonly TestWallet[],
  state: LoadState,
): Promise<void> => {
  for (let round = 0; !state.stopped; round += 1) {
    const sent = wallets.flatMap((wallet, index) => {
      const http: HttpOperation = {
        request: betCommand({ wallet, amount: BET_AMOUNT }),
        apiIndex: (round + index) % harness.apis.instances.length,
        status: undefined,
        transactionId: undefined,
      };
      const queued: QueueOperation = {
        request: betCommand({ wallet, amount: BET_AMOUNT }),
        messageId: `msg-${randomUUID()}`,
      };
      state.http.push(http);
      state.queue.push(queued);
      return [submitHttp(harness, http), publishQueue(harness, queued)];
    });
    await Promise.all(sent);
  }
};

const committedCount = async (databaseUrl: string): Promise<number> => {
  const rows = await query<{ committed: number }>(
    databaseUrl,
    "SELECT count(*)::int AS committed FROM wager_transactions WHERE kind <> 'OPENING'",
  );
  return rows[0]?.committed ?? 0;
};

const unanswered = (state: LoadState): HttpOperation[] =>
  state.http.filter((target) => target.status !== 200);

const retryUnanswered = async (harness: Harness, state: LoadState): Promise<void> => {
  for (let attempt = 0; attempt < HTTP_RETRY_ATTEMPTS; attempt += 1) {
    const pending = unanswered(state);
    if (pending.length === 0) {
      return;
    }
    await Promise.all(pending.map((target) => submitHttp(harness, target)));
  }
};

const externalIdsOf = (state: LoadState): string[] =>
  [...state.http, ...state.queue].map((target) => target.request.body.externalTransactionId);

const transactionsOf = (databaseUrl: string): Promise<StoredTransaction[]> =>
  query<StoredTransaction>(
    databaseUrl,
    `SELECT t.external_transaction_id, t.id, t.status,
            (SELECT count(*)::int FROM ledger_entries e WHERE e.transaction_id = t.id) AS entries,
            (SELECT count(*)::int FROM outbox_messages o
              WHERE o.event_type = 'WagerTransactionProcessed'
                AND o.payload->'data'->>'externalTransactionId' = t.external_transaction_id
            ) AS processed_events
       FROM wager_transactions t
      WHERE t.kind <> 'OPENING'`,
  );

const waitUntilSettled = (harness: Harness, state: LoadState): Promise<void> =>
  waitFor(async () => {
    const queue = await countMessages(harness.sqs, harness.queues.urls.wagerTransactions);
    const rows = await query<{ processed: number; open: number; unpublished: number }>(
      harness.database.superuserUrl,
      `SELECT
         (SELECT count(*)::int FROM wager_transactions
           WHERE kind <> 'OPENING' AND status = 'PROCESSED') AS processed,
         (SELECT count(*)::int FROM wager_transactions
           WHERE kind <> 'OPENING' AND status <> 'PROCESSED') AS open,
         (SELECT count(*)::int FROM outbox_messages WHERE published_at IS NULL) AS unpublished`,
    );
    const [counts] = rows;
    return (
      queue.total === 0 &&
      counts?.open === 0 &&
      counts.unpublished === 0 &&
      counts.processed === externalIdsOf(state).length
    );
  }, SETTLE_WAIT);

const expectedBalance = (wallet: TestWallet, bets: number): string => {
  const stake = Money.from({ amount: BET_AMOUNT, currency: wallet.balance.currency });
  let balance = Money.from(wallet.balance);
  for (let bet = 0; bet < bets; bet += 1) {
    balance = balance.subtract(stake);
  }
  return balance.toJSON().amount;
};

describe('concurrency 8: restart consistency', () => {
  it('gives every submitted operation exactly one outcome after every process is killed', async () => {
    const harness = await startHarness();
    try {
      const wallets = await createWallets(harness);
      const state: LoadState = { stopped: false, http: [], queue: [] };
      const load = runLoad(harness, wallets, state);
      await waitFor(
        async () => (await committedCount(harness.database.superuserUrl)) >= COMMITTED_BEFORE_KILL,
        LOAD_WAIT,
      );
      const exitCodes = await Promise.all(
        everyInstance(harness).map((instance) => instance.kill('SIGKILL')),
      );
      state.stopped = true;
      await load;
      expect(exitCodes.every((code) => code === 137)).toBe(true);
      expect(unanswered(state).length).toBeGreaterThan(0);

      await Promise.all(
        everyInstance(harness).map((instance) => withPortRetry(() => instance.restart())),
      );
      await retryUnanswered(harness, state);
      expect(unanswered(state)).toEqual([]);
      await waitUntilSettled(harness, state);

      const stored = await transactionsOf(harness.database.superuserUrl);
      const externalIds = externalIdsOf(state);
      expect(stored).toHaveLength(externalIds.length);
      const byExternalId = new Map(stored.map((row) => [row.external_transaction_id, row]));
      expect(new Set(byExternalId.keys())).toEqual(new Set(externalIds));
      for (const row of stored) {
        expect(row).toMatchObject({ status: 'PROCESSED', entries: 2, processed_events: 1 });
      }
      for (const target of state.http) {
        expect(target.transactionId).toBe(
          byExternalId.get(target.request.body.externalTransactionId)?.id,
        );
      }

      const inbox = await query<{ message_id: string; processed: boolean }>(
        harness.database.superuserUrl,
        `SELECT message_id, processed_at IS NOT NULL AS processed
           FROM inbox_messages WHERE consumer_name = $1`,
        [CONSUMER_NAME],
      );
      expect(inbox).toHaveLength(state.queue.length);
      expect(new Set(inbox.map((row) => row.message_id))).toEqual(
        new Set(state.queue.map((target) => target.messageId)),
      );
      expect(inbox.every((row) => row.processed)).toBe(true);
      expect(
        (await countMessages(harness.sqs, harness.queues.urls.wagerTransactionsDlq)).total,
      ).toBe(0);

      const balances = await query<{ id: string; balance: string }>(
        harness.database.superuserUrl,
        'SELECT id, balance::text AS balance FROM wallets WHERE id = ANY($1)',
        [wallets.map((wallet) => wallet.id)],
      );
      const betsPerWallet = (wallet: TestWallet): number =>
        [...state.http, ...state.queue].filter(
          (target) => target.request.body.walletId === wallet.id,
        ).length;
      expect(new Map(balances.map((row) => [row.id, row.balance]))).toEqual(
        new Map(
          wallets.map((wallet) => [wallet.id, expectedBalance(wallet, betsPerWallet(wallet))]),
        ),
      );
    } finally {
      await stopHarness(harness);
    }
  });
});
