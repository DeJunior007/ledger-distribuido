import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { OutboxMessage } from '@domain/messaging/outbox-message';
import { MikroOrmUnitOfWork } from '@infrastructure/persistence/mikro-orm-unit-of-work';
import { countMessages, peekMessages } from '@test/support/sqs';
import { createTestApp } from '@test/support/test-app';
import type { TestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import { waitFor } from '@test/support/wait-for';

const WAIT = { timeoutMs: 20_000, intervalMs: 100 } as const;
const TEST_TIMEOUT_MS = 60_000;
const INVALID_SQS_CHARACTER = '￿';
const ACCEPTED_COUNT = 5;
const REFUSED_POSITION = 3;

interface OutboxStateRow {
  readonly id: string;
  readonly permanent_failures: number;
  readonly published_at: Date | null;
  readonly parked_at: Date | null;
  readonly last_error_code: string | null;
}

const walletEvent = (occurredAt: Date, note: string): OutboxMessage => {
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
      data: { walletId: aggregateId, note },
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

const outboxRows = async (url: string): Promise<OutboxStateRow[]> => {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query<OutboxStateRow>(
      `SELECT id, permanent_failures, published_at, parked_at, last_error_code
       FROM outbox_messages ORDER BY id`,
    );
    return result.rows;
  } finally {
    await client.end();
  }
};

describe('outbox partial batch', () => {
  it(
    'publishes the rest of the batch when SQS refuses one entry as a sender fault',
    async () => {
      const database = await createTestDatabase();
      const app = await createTestApp({
        roles: ['outbox'],
        env: { DATABASE_URL: database.appUrl },
      });
      try {
        const now = new Date();
        const accepted = Array.from({ length: ACCEPTED_COUNT }, () => walletEvent(now, 'ok'));
        const refused = walletEvent(now, `bad ${INVALID_SQS_CHARACTER} body`);
        const messages = [
          ...accepted.slice(0, REFUSED_POSITION),
          refused,
          ...accepted.slice(REFUSED_POSITION),
        ];
        const refusedId = refused.id;
        const acceptedIds = accepted.map((message) => message.id).sort();
        await enqueueAll(app, messages);

        await waitFor(async () => {
          const rows = await outboxRows(database.superuserUrl);
          const refusedRow = rows.find((row) => row.id === refusedId);
          const published = rows.filter((row) => row.published_at !== null).map((row) => row.id);
          return (
            refusedRow !== undefined &&
            refusedRow.permanent_failures >= 1 &&
            published.length === acceptedIds.length
          );
        }, WAIT);

        const rows = await outboxRows(database.superuserUrl);
        expect(
          rows
            .filter((row) => row.published_at !== null)
            .map((row) => row.id)
            .sort(),
        ).toEqual(acceptedIds);
        expect(rows.find((row) => row.id === refusedId)).toMatchObject({
          published_at: null,
          last_error_code: 'InvalidMessageContents',
        });
        expect((await countMessages(app.sqs, app.queueUrls.walletEvents)).total).toBe(
          acceptedIds.length,
        );
        const received = await peekMessages(app.sqs, app.queueUrls.walletEvents);
        expect(received.map((message) => message.deduplicationId).sort()).toEqual(acceptedIds);
      } finally {
        await app.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
