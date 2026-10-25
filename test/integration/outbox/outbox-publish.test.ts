import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { OutboxMessage } from '@domain/messaging/outbox-message';
import { MikroOrmUnitOfWork } from '@infrastructure/persistence/mikro-orm-unit-of-work';
import { countMessages, parseEnvelope, peekMessages } from '@test/support/sqs';
import { createTestApp } from '@test/support/test-app';
import type { TestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import { waitFor } from '@test/support/wait-for';

const WAIT = { timeoutMs: 20_000, intervalMs: 100 } as const;
const TEST_TIMEOUT_MS = 60_000;
const EVENT_COUNT = 25;

interface PublishedRow {
  readonly id: string;
  readonly published_at: Date | null;
}

const walletEvent = (occurredAt: Date): OutboxMessage => {
  const id = randomUUID();
  const aggregateId = randomUUID();
  return OutboxMessage.rehydrate({
    id,
    aggregateId,
    eventType: 'WalletBalanceChanged',
    payload: {
      eventId: id,
      eventType: 'WalletBalanceChanged',
      aggregateId,
      correlationId: `corr-${id}`,
      occurredAt: occurredAt.toISOString(),
      version: 1,
      data: { walletId: aggregateId },
    },
    occurredAt,
    attempts: 0,
    permanentFailures: 0,
    nextAttemptAt: occurredAt,
    lockedUntil: undefined,
    lockedBy: undefined,
    publishedAt: undefined,
    parkedAt: undefined,
    lastErrorCode: undefined,
  });
};

const enqueueAll = (app: TestApp, messages: readonly OutboxMessage[]): Promise<void> =>
  new MikroOrmUnitOfWork(app.orm, app.config).run('short', async (repos) => {
    for (const message of messages) {
      repos.outbox.enqueue(message);
    }
    await repos.flush();
  });

const publishedRows = async (url: string): Promise<PublishedRow[]> => {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query<PublishedRow>(
      'SELECT id, published_at FROM outbox_messages ORDER BY id',
    );
    return result.rows;
  } finally {
    await client.end();
  }
};

describe('outbox publishing', () => {
  it(
    'publishes every committed event to the events queue and marks each row as published',
    async () => {
      const database = await createTestDatabase();
      const app = await createTestApp({
        roles: ['outbox'],
        env: { DATABASE_URL: database.appUrl },
      });
      try {
        const now = new Date();
        const messages = Array.from({ length: EVENT_COUNT }, () => walletEvent(now));
        await enqueueAll(app, messages);

        await waitFor(async () => {
          const rows = await publishedRows(database.superuserUrl);
          return rows.filter((row) => row.published_at !== null).length === EVENT_COUNT;
        }, WAIT);

        const rows = await publishedRows(database.superuserUrl);
        expect(rows).toHaveLength(EVENT_COUNT);
        expect(rows.every((row) => row.published_at !== null)).toBe(true);
        expect((await countMessages(app.sqs, app.queueUrls.walletEvents)).total).toBe(EVENT_COUNT);
        const received = await peekMessages(app.sqs, app.queueUrls.walletEvents);
        expect(received.map((message) => message.deduplicationId).sort()).toEqual(
          messages.map((message) => message.id).sort(),
        );
        const byDedupId = new Map(received.map((message) => [message.deduplicationId, message]));
        for (const message of messages) {
          const delivered = byDedupId.get(message.id);
          expect(delivered?.groupId).toBe(message.aggregateId);
          expect(delivered === undefined ? undefined : parseEnvelope(delivered)).toEqual(
            message.payload,
          );
          expect(delivered?.attributes).toMatchObject({ eventType: 'WalletBalanceChanged' });
        }
      } finally {
        await app.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
