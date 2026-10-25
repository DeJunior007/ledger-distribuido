import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Client } from 'pg';
import type { QueryResultRow } from 'pg';
import type { WagerTransactionRequest } from '@interfaces/http/schemas/wager-transaction.schema';
import {
  betCommand,
  createWalletViaApi,
  refundCommand,
  rollbackCommand,
  submitViaApi,
  toMessageData,
} from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import { SpawnInstancesError, spawnInstances } from '@test/support/spawn-instances';
import type { SpawnedInstances } from '@test/support/spawn-instances';
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

const WALLETS_PER_GROUP = 8;
const READY_TIMEOUT_MS = 120_000;
const SPAWN_ATTEMPTS = 3;
const PENDING_WAIT = { timeoutMs: 60_000, intervalMs: 200 } as const;
const SETTLE_WAIT = { timeoutMs: 90_000, intervalMs: 250 } as const;

type Channel = 'http' | 'sqs';

interface Operation {
  readonly channel: Channel;
  readonly request: WagerTransactionRequest;
  readonly messageId: string;
}

interface WalletPlan {
  readonly wallet: TestWallet;
  readonly bet: Operation;
  readonly refund: Operation;
  readonly rollback: Operation;
}

interface Dispatched {
  readonly operation: Operation;
  readonly httpStatus: number | undefined;
}

interface StoredTransaction {
  readonly external_transaction_id: string;
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly failure_code: string | null;
  readonly reference_transaction_id: string | null;
  readonly entries: number;
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

const operation = (channel: Channel, request: WagerTransactionRequest): Operation => ({
  channel,
  request,
  messageId: `msg-${randomUUID()}`,
});

const planFor = (wallet: TestWallet, index: number): WalletPlan => {
  const roundId = `round-${randomUUID()}`;
  const bet = betCommand({ wallet, roundId });
  const reference = {
    wallet,
    roundId,
    referenceExternalTransactionId: bet.body.externalTransactionId,
  };
  const refundChannel: Channel = index % 4 < 2 ? 'http' : 'sqs';
  return {
    wallet,
    bet: operation(index % 2 === 0 ? 'http' : 'sqs', bet),
    refund: operation(refundChannel, refundCommand(reference)),
    rollback: operation(refundChannel === 'http' ? 'sqs' : 'http', rollbackCommand(reference)),
  };
};

const dispatch = async (
  harness: Harness,
  target: Operation,
  index: number,
): Promise<Dispatched> => {
  if (target.channel === 'sqs') {
    await publishEnvelope(
      harness.sqs,
      harness.queues.urls.wagerTransactions,
      buildEnvelope({ messageId: target.messageId, data: toMessageData(target.request) }),
      { groupId: target.messageId },
    );
    return { operation: target, httpStatus: undefined };
  }
  const api = harness.apis.instance(index % harness.apis.instances.length);
  const response = await submitViaApi(api.baseUrl, harness.providerToken, target.request);
  await response.arrayBuffer();
  return { operation: target, httpStatus: response.status };
};

const dispatchAll = (harness: Harness, operations: readonly Operation[]): Promise<Dispatched[]> =>
  Promise.all(operations.map((target, index) => dispatch(harness, target, index)));

const externalIdsOf = (operations: readonly Operation[]): string[] =>
  operations.map((target) => target.request.body.externalTransactionId);

const transactionsOf = (
  databaseUrl: string,
  externalIds: readonly string[],
): Promise<StoredTransaction[]> =>
  query<StoredTransaction>(
    databaseUrl,
    `SELECT t.external_transaction_id, t.id, t.kind, t.status, t.failure_code,
            t.reference_transaction_id,
            (SELECT count(*)::int FROM ledger_entries e WHERE e.transaction_id = t.id) AS entries
       FROM wager_transactions t
      WHERE t.external_transaction_id = ANY($1)`,
    [externalIds],
  );

const reversalsOf = (plan: WalletPlan): Operation[] => [plan.refund, plan.rollback];

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
      spawnInstances({ role: 'scheduler', count: 2, env, readyTimeoutMs: READY_TIMEOUT_MS }),
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

const createWallets = async (harness: Harness, count: number): Promise<TestWallet[]> => {
  const operatorToken = await harness.issuer.token({ role: 'operator' });
  return Promise.all(
    Array.from({ length: count }, (_, index) =>
      createWalletViaApi(
        harness.apis.instance(index % harness.apis.instances.length).baseUrl,
        operatorToken,
      ),
    ),
  );
};

const waitUntilPending = (databaseUrl: string, externalIds: readonly string[]): Promise<void> =>
  waitFor(async () => {
    const rows = await transactionsOf(databaseUrl, externalIds);
    return (
      rows.length === externalIds.length && rows.every((row) => row.status === 'PENDING_REFERENCE')
    );
  }, PENDING_WAIT);

const waitUntilSettled = (harness: Harness, externalIds: readonly string[]): Promise<void> =>
  waitFor(async () => {
    const rows = await transactionsOf(harness.database.superuserUrl, externalIds);
    const queue = await countMessages(harness.sqs, harness.queues.urls.wagerTransactions);
    return (
      queue.total === 0 &&
      rows.length === externalIds.length &&
      rows.every((row) => row.status !== 'PENDING_REFERENCE')
    );
  }, SETTLE_WAIT);

const byExternalId = (rows: readonly StoredTransaction[]): Map<string, StoredTransaction> =>
  new Map(rows.map((row) => [row.external_transaction_id, row]));

describe('concurrency 7: reversals before their reference', () => {
  it('reverses each reference at most once when REFUND and ROLLBACK race the BET', async () => {
    const harness = await startHarness();
    try {
      const wallets = await createWallets(harness, WALLETS_PER_GROUP * 2);
      const early = wallets.slice(0, WALLETS_PER_GROUP).map(planFor);
      const racing = wallets.slice(WALLETS_PER_GROUP).map(planFor);
      const plans = [...early, ...racing];

      const earlyReversals = early.flatMap(reversalsOf);
      const earlyDispatched = await dispatchAll(harness, earlyReversals);
      await waitUntilPending(harness.database.superuserUrl, externalIdsOf(earlyReversals));

      const racingDispatched = await dispatchAll(harness, [
        ...early.map((plan) => plan.bet),
        ...racing.flatMap((plan) => [plan.bet, plan.refund, plan.rollback]),
      ]);

      const allOperations = plans.flatMap((plan) => [plan.bet, plan.refund, plan.rollback]);
      await waitUntilSettled(harness, externalIdsOf(allOperations));

      expect(
        earlyDispatched
          .filter((sent) => sent.operation.channel === 'http')
          .map((sent) => sent.httpStatus),
      ).toEqual(earlyReversals.filter((sent) => sent.channel === 'http').map(() => 202));
      for (const sent of racingDispatched) {
        if (sent.operation.channel === 'http') {
          expect([200, 202, 422]).toContain(sent.httpStatus ?? 0);
        }
      }

      const stored = byExternalId(
        await transactionsOf(harness.database.superuserUrl, externalIdsOf(allOperations)),
      );
      for (const plan of plans) {
        const bet = stored.get(plan.bet.request.body.externalTransactionId);
        expect(bet).toMatchObject({ kind: 'BET', status: 'PROCESSED', entries: 2 });
        const reversals = reversalsOf(plan).map((target) =>
          stored.get(target.request.body.externalTransactionId),
        );
        const processed = reversals.filter((row) => row?.status === 'PROCESSED');
        const rejected = reversals.filter((row) => row?.status === 'REJECTED');
        expect(processed).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(processed[0]).toMatchObject({ reference_transaction_id: bet?.id, entries: 2 });
        expect(rejected[0]).toMatchObject({
          failure_code: 'REFERENCE_ALREADY_REVERSED',
          reference_transaction_id: bet?.id,
          entries: 0,
        });
      }

      const doubleReversed = await query(
        harness.database.superuserUrl,
        `SELECT reference_transaction_id
           FROM wager_transactions
          WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED'
          GROUP BY reference_transaction_id
         HAVING count(*) > 1`,
      );
      expect(doubleReversed).toEqual([]);

      const balances = await query<{ id: string; balance: string }>(
        harness.database.superuserUrl,
        'SELECT id, balance::text AS balance FROM wallets WHERE id = ANY($1)',
        [wallets.map((wallet) => wallet.id)],
      );
      expect(new Map(balances.map((row) => [row.id, row.balance]))).toEqual(
        new Map(wallets.map((wallet) => [wallet.id, wallet.balance.amount])),
      );

      const retries = await query<{ waited: number; open: number }>(
        harness.database.superuserUrl,
        `SELECT count(*)::int AS waited,
                count(*) FILTER (WHERE resolved_at IS NULL)::int AS open
           FROM pending_reference_retries`,
      );
      expect(retries[0]?.open).toBe(0);
      expect(retries[0]?.waited ?? 0).toBeGreaterThanOrEqual(earlyReversals.length);
    } finally {
      await stopHarness(harness);
    }
  });
});
