import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Client } from 'pg';
import { SUBMISSION_CONSUMER } from '@application/services/submission-fast-path';
import { createMetricsRegistry } from '@infrastructure/observability/metrics.registry';
import { betCommand, createWalletViaUseCase, toMessageData } from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import { buildEnvelope, countMessages, publishEnvelope } from '@test/support/sqs';
import type { WagerTransactionEnvelope } from '@test/support/sqs';
import { createTestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

const WAIT = { timeoutMs: 40_000, intervalMs: 100 } as const;
const TEST_TIMEOUT_MS = 90_000;
const CONCURRENT_COPIES = 6;

const queryRows = async (
  databaseUrl: string,
  sql: string,
  params: readonly unknown[],
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

const inboxDuplicates = async (): Promise<number> => {
  const metric = createMetricsRegistry().registry.getSingleMetric('jungle_inbox_duplicates_total');
  if (metric === undefined) {
    throw new TypeError('inbox duplicates metric is not registered');
  }
  const data = await metric.get();
  return data.values.find((sample) => sample.labels.consumer === SUBMISSION_CONSUMER)?.value ?? 0;
};

const queueIsEmpty = async (client: SQSClient, queueUrl: string): Promise<boolean> =>
  (await countMessages(client, queueUrl)).total === 0;

const expectSingleEffect = async (
  databaseUrl: string,
  wallet: TestWallet,
  envelope: WagerTransactionEnvelope,
): Promise<void> => {
  const transactions = await queryRows(
    databaseUrl,
    `select id, status from wager_transactions
       where provider_id = $1 and external_transaction_id = $2`,
    [TEST_PROVIDER_ID, envelope.data.externalTransactionId],
  );
  expect(transactions).toHaveLength(1);
  expect(transactions[0]?.status).toBe('PROCESSED');
  const postings = await queryRows(
    databaseUrl,
    'select count(*)::int as postings from ledger_entries where transaction_id = $1',
    [transactions[0]?.id],
  );
  expect(postings[0]?.postings).toBe(2);
  const records = await queryRows(
    databaseUrl,
    `select count(*)::int as records from idempotency_records
       where provider_id = $1 and idempotency_key = $2`,
    [TEST_PROVIDER_ID, envelope.data.idempotencyKey],
  );
  expect(records[0]?.records).toBe(1);
  const inbox = await queryRows(
    databaseUrl,
    'select count(*)::int as deliveries from inbox_messages where message_id = $1',
    [envelope.messageId],
  );
  expect(inbox[0]?.deliveries).toBe(1);
  const wallets = await queryRows(databaseUrl, 'select balance from wallets where id = $1', [
    wallet.id,
  ]);
  expect(wallets[0]?.balance).toBe('990.00');
};

describe('wager transaction consumer redelivery', () => {
  it(
    'applies a message redelivered in sequence once and counts the duplicate',
    async () => {
      const database = await createTestDatabase();
      const queues = await createTestQueues();
      const app = await createTestApp({
        roles: ['consumer'],
        env: { DATABASE_URL: database.appUrl, ...queues.env },
      });
      try {
        const wallet = await createWalletViaUseCase(app);
        const envelope = buildEnvelope({ data: toMessageData(betCommand({ wallet })) });
        await publishEnvelope(app.sqs, queues.urls.wagerTransactions, envelope);
        await waitFor(async () => {
          const rows = await queryRows(
            database.superuserUrl,
            'select processed_at from inbox_messages where message_id = $1',
            [envelope.messageId],
          );
          return rows[0]?.processed_at instanceof Date;
        }, WAIT);
        await waitFor(() => queueIsEmpty(app.sqs, queues.urls.wagerTransactions), WAIT);
        const duplicatesBefore = await inboxDuplicates();

        await publishEnvelope(app.sqs, queues.urls.wagerTransactions, envelope, {
          deduplicationId: randomUUID(),
        });
        await waitFor(async () => (await inboxDuplicates()) > duplicatesBefore, WAIT);
        await waitFor(() => queueIsEmpty(app.sqs, queues.urls.wagerTransactions), WAIT);

        expect(await inboxDuplicates()).toBe(duplicatesBefore + 1);
        await expectSingleEffect(database.superuserUrl, wallet, envelope);
        expect(await queueIsEmpty(app.sqs, queues.urls.wagerTransactionsDlq)).toBe(true);
      } finally {
        await app.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'applies copies delivered concurrently to two consumers once',
    async () => {
      const database = await createTestDatabase();
      const queues = await createTestQueues();
      const env = { DATABASE_URL: database.appUrl, ...queues.env };
      const first = await createTestApp({ roles: ['consumer'], env });
      try {
        const second = await createTestApp({ roles: ['consumer'], env });
        try {
          const wallet = await createWalletViaUseCase(first);
          const envelope = buildEnvelope({ data: toMessageData(betCommand({ wallet })) });
          await Promise.all(
            Array.from({ length: CONCURRENT_COPIES }, () =>
              publishEnvelope(first.sqs, queues.urls.wagerTransactions, envelope, {
                groupId: randomUUID(),
                deduplicationId: randomUUID(),
              }),
            ),
          );

          await waitFor(() => queueIsEmpty(first.sqs, queues.urls.wagerTransactions), WAIT);

          await expectSingleEffect(database.superuserUrl, wallet, envelope);
          expect(await queueIsEmpty(first.sqs, queues.urls.wagerTransactionsDlq)).toBe(true);
        } finally {
          await second.stop();
        }
      } finally {
        await first.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
