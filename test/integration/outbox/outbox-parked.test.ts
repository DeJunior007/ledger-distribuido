import { describe, expect, it } from 'bun:test';
import { CreateQueueCommand, DeleteQueueCommand } from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Client } from 'pg';
import { createWalletViaUseCase } from '@test/support/fixtures';
import { countMessages } from '@test/support/sqs';
import { createTestApp } from '@test/support/test-app';
import type { TestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { createTestQueues } from '@test/support/test-queues';
import type { TestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';
import { requeueParkedOutbox } from '../../../scripts/outbox-requeue';

const PARK_WAIT = { timeoutMs: 30_000, intervalMs: 100 } as const;
const PUBLISH_WAIT = { timeoutMs: 20_000, intervalMs: 100 } as const;
const TEST_TIMEOUT_MS = 90_000;
const PERMANENT_FAILURES_TO_PARK = 3;
const PARKED_RETRY_MS = 3_600_000;
const MISSING_QUEUE_CODES: readonly string[] = [
  'QueueDoesNotExist',
  'AWS.SimpleQueueService.NonExistentQueue',
];

interface OutboxStateRow {
  readonly id: string;
  readonly attempts: number;
  readonly permanent_failures: number;
  readonly next_attempt_at: Date;
  readonly parked_at: Date | null;
  readonly published_at: Date | null;
  readonly last_error_code: string | null;
  readonly locked_by: string | null;
}

const outboxRows = async (database: TestDatabase): Promise<OutboxStateRow[]> => {
  const client = new Client({ connectionString: database.superuserUrl });
  await client.connect();
  try {
    const result = await client.query<OutboxStateRow>(
      `SELECT id, attempts, permanent_failures, next_attempt_at, parked_at, published_at,
              last_error_code, locked_by
       FROM outbox_messages ORDER BY id`,
    );
    return result.rows;
  } finally {
    await client.end();
  }
};

const deleteQueue = async (client: SQSClient, queueUrl: string): Promise<void> => {
  await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
};

const recreateEventsQueue = async (client: SQSClient, queues: TestQueues): Promise<void> => {
  const created = await client.send(
    new CreateQueueCommand({
      QueueName: queues.names.walletEvents,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }),
  );
  expect(created.QueueUrl).toBe(queues.urls.walletEvents);
};

const isParked = (row: OutboxStateRow): boolean =>
  row.parked_at !== null && row.published_at === null && row.locked_by === null;

const waitUntilParked = (database: TestDatabase, count: number): Promise<void> =>
  waitFor(async () => {
    const rows = await outboxRows(database);
    return rows.length === count && rows.every(isParked);
  }, PARK_WAIT);

const waitUntilPublished = (database: TestDatabase, count: number): Promise<void> =>
  waitFor(async () => {
    const rows = await outboxRows(database);
    return rows.length === count && rows.every((row) => row.published_at !== null);
  }, PUBLISH_WAIT);

const expectParkedAfterThirdPermanentFailure = (rows: readonly OutboxStateRow[]): void => {
  for (const row of rows) {
    expect(row.permanent_failures).toBe(PERMANENT_FAILURES_TO_PARK);
    expect(row.attempts).toBe(PERMANENT_FAILURES_TO_PARK);
    expect(MISSING_QUEUE_CODES).toContain(row.last_error_code ?? '');
    const parkedAt = row.parked_at?.getTime() ?? 0;
    expect(row.next_attempt_at.getTime()).toBeGreaterThanOrEqual(parkedAt + PARKED_RETRY_MS);
  }
};

const startOutbox = (database: TestDatabase, queues: TestQueues): Promise<TestApp> =>
  createTestApp({ roles: ['outbox'], env: { DATABASE_URL: database.appUrl, ...queues.env } });

describe('outbox parking', () => {
  it(
    'parks events on the third permanent failure and publishes them after the requeue script',
    async () => {
      const database = await createTestDatabase();
      const queues = await createTestQueues();
      const app = await startOutbox(database, queues);
      try {
        await deleteQueue(app.sqs, queues.urls.walletEvents);
        await createWalletViaUseCase(app);

        await waitUntilParked(database, 2);
        expectParkedAfterThirdPermanentFailure(await outboxRows(database));

        await recreateEventsQueue(app.sqs, queues);
        expect(await requeueParkedOutbox(app.config)).toBe(2);

        await waitUntilPublished(database, 2);
        expect((await countMessages(app.sqs, queues.urls.walletEvents)).total).toBe(2);
      } finally {
        await app.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'publishes parked events once the worker restarts after the queue is fixed',
    async () => {
      const database = await createTestDatabase();
      const queues = await createTestQueues();
      const first = await startOutbox(database, queues);
      try {
        await deleteQueue(first.sqs, queues.urls.walletEvents);
        await createWalletViaUseCase(first);
        await waitUntilParked(database, 2);
        expectParkedAfterThirdPermanentFailure(await outboxRows(database));
        await recreateEventsQueue(first.sqs, queues);
      } finally {
        await first.stop();
      }

      const rows = await outboxRows(database);
      expect(rows.every(isParked)).toBe(true);

      const restarted = await startOutbox(database, queues);
      try {
        await waitUntilPublished(database, 2);
        expect((await countMessages(restarted.sqs, queues.urls.walletEvents)).total).toBe(2);
      } finally {
        await restarted.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
