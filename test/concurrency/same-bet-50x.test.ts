import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import {
  betCommand,
  createWalletViaApi,
  submitViaApi,
  toMessageData,
} from '@test/support/fixtures';
import { spawnInstances } from '@test/support/spawn-instances';
import type { SpawnedInstances } from '@test/support/spawn-instances';
import {
  buildEnvelope,
  countMessages,
  createTestSqsClient,
  publishEnvelope,
} from '@test/support/sqs';
import { createTestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID, TestIssuer } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

const INSTANCES_PER_ROLE = 3;
const HTTP_COPIES = 25;
const QUEUE_COPIES = 25;
const CONSUMER_NAME = 'wager-transactions-consumer';
const DRAIN_WAIT = { timeoutMs: 90_000, intervalMs: 250 } as const;
const PROCESS_ENV = { DB_POOL_MAX: '10' } as const;

type Json = Record<string, unknown>;

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

const readResponse = async (response: Response): Promise<{ status: number; body: Json }> => {
  const parsed: unknown = await response.json();
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`unexpected body: ${JSON.stringify(parsed)}`);
  }
  return { status: response.status, body: { ...parsed } };
};

const withoutReplayFlag = (body: Json): Json =>
  Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'idempotentReplay'));

describe('the same bet fifty times in parallel', () => {
  it('debits once across three apis and three consumers', async () => {
    const database = await createTestDatabase();
    const queues = await createTestQueues();
    const issuer = await TestIssuer.start();
    const sqs = createTestSqsClient();
    const env = {
      DATABASE_URL: database.appUrl,
      ...queues.env,
      ...issuer.authConfig,
      ...PROCESS_ENV,
    };
    const groups: SpawnedInstances[] = [];
    try {
      const apis = await spawnInstances({ role: 'api', count: INSTANCES_PER_ROLE, env });
      groups.push(apis);
      groups.push(await spawnInstances({ role: 'consumer', count: INSTANCES_PER_ROLE, env }));
      const operatorToken = await issuer.token({ role: 'operator' });
      const providerToken = await issuer.token({ role: 'provider', providerId: TEST_PROVIDER_ID });
      const wallet = await createWalletViaApi(apis.instance(0).baseUrl, operatorToken);
      const bet = betCommand({ wallet });
      const messageIds = Array.from({ length: QUEUE_COPIES }, () => `msg-${randomUUID()}`);

      const [httpResponses, sqsMessageIds] = await Promise.all([
        Promise.all(
          Array.from({ length: HTTP_COPIES }, (_, index) =>
            submitViaApi(
              apis.instance(index % INSTANCES_PER_ROLE).baseUrl,
              providerToken,
              bet,
            ).then(readResponse),
          ),
        ),
        Promise.all(
          messageIds.map((messageId) =>
            publishEnvelope(
              sqs,
              queues.urls.wagerTransactions,
              buildEnvelope({ messageId, data: toMessageData(bet) }),
              { groupId: `group-${randomUUID()}`, deduplicationId: `dedup-${randomUUID()}` },
            ),
          ),
        ),
      ]);
      expect(new Set(sqsMessageIds).size).toBe(QUEUE_COPIES);

      await waitFor(async () => {
        const counts = await countMessages(sqs, queues.urls.wagerTransactions);
        const inbox = await queryRows(
          database.appUrl,
          `SELECT count(*)::int AS count FROM inbox_messages
            WHERE consumer_name = $1 AND processed_at IS NULL`,
          [CONSUMER_NAME],
        );
        return counts.total === 0 && inbox[0]?.count === 0;
      }, DRAIN_WAIT);

      const transactions = await queryRows(
        database.appUrl,
        `SELECT id::text AS id, status FROM wager_transactions
          WHERE provider_id = $1 AND external_transaction_id = $2`,
        [TEST_PROVIDER_ID, bet.body.externalTransactionId],
      );
      expect(transactions).toEqual([{ id: expect.any(String), status: 'PROCESSED' }]);
      const transactionId = transactions[0]?.id;

      const entries = await queryRows(
        database.appUrl,
        `SELECT account_kind, direction, amount::text AS amount FROM ledger_entries
          WHERE transaction_id = $1 ORDER BY account_kind`,
        [transactionId],
      );
      expect(entries).toEqual([
        { account_kind: 'HOUSE', direction: 'CREDIT', amount: '10.00' },
        { account_kind: 'WALLET', direction: 'DEBIT', amount: '10.00' },
      ]);
      const walletDebits = await queryRows(
        database.appUrl,
        `SELECT count(*)::int AS count FROM wallet_ledger_entries
          WHERE wallet_id = $1 AND direction = 'DEBIT'`,
        [wallet.id],
      );
      expect(walletDebits).toEqual([{ count: 1 }]);
      const balances = await queryRows(
        database.appUrl,
        'SELECT balance::text AS balance FROM wallets WHERE id = $1',
        [wallet.id],
      );
      expect(balances).toEqual([{ balance: '990.00' }]);
      const idempotency = await queryRows(
        database.appUrl,
        `SELECT transaction_id::text AS "transactionId" FROM idempotency_records
          WHERE provider_id = $1 AND idempotency_key = $2`,
        [TEST_PROVIDER_ID, bet.idempotencyKey],
      );
      expect(idempotency).toEqual([{ transactionId }]);

      expect(httpResponses.map((response) => response.status)).toEqual(
        httpResponses.map(() => 200),
      );
      const replays = httpResponses.filter((response) => response.body.idempotentReplay === true);
      expect([HTTP_COPIES - 1, HTTP_COPIES]).toContain(replays.length);
      expect(
        httpResponses.filter((response) => response.body.idempotentReplay === false),
      ).toHaveLength(HTTP_COPIES - replays.length);
      const expectedBody = {
        transactionId,
        status: 'PROCESSED',
        kind: bet.body.kind,
        balance: { amount: '990.00', currency: 'BRL' },
      };
      expect(httpResponses.map((response) => withoutReplayFlag(response.body))).toEqual(
        httpResponses.map(() => expectedBody),
      );

      const inbox = await queryRows(
        database.appUrl,
        `SELECT message_id AS "messageId", processed_at IS NOT NULL AS processed
           FROM inbox_messages WHERE consumer_name = $1`,
        [CONSUMER_NAME],
      );
      expect(inbox.length).toBeLessThanOrEqual(QUEUE_COPIES);
      expect(inbox.every((row) => row.processed === true)).toBe(true);
      expect(new Set(inbox.map((row) => row.messageId)).size).toBe(inbox.length);
      expect(inbox.every((row) => messageIds.some((id) => id === row.messageId))).toBe(true);
      expect((await countMessages(sqs, queues.urls.wagerTransactionsDlq)).total).toBe(0);
    } finally {
      sqs.destroy();
      await Promise.all(groups.map((group) => group.stop()));
      await issuer.stop();
    }
  });
});
