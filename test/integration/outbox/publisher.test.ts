import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { OutboxMessage } from '@domain/messaging/outbox-message';
import { SqsEventPublisher } from '@infrastructure/messaging/sqs-event-publisher';
import { countMessages, createTestSqsClient, peekMessages } from '@test/support/sqs';
import { createTestQueues } from '@test/support/test-queues';
import type { TestQueues } from '@test/support/test-queues';

const INVALID_SQS_CHARACTER = '￿';
const CLOSED_PORT_ENDPOINT = 'http://127.0.0.1:1';

const outboxMessage = (note = 'ok'): OutboxMessage => {
  const id = randomUUID();
  const aggregateId = randomUUID();
  const occurredAt = new Date('2026-10-24T12:00:00.000Z');
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

const outboxMessages = (count: number): OutboxMessage[] =>
  Array.from({ length: count }, () => outboxMessage());

describe('SqsEventPublisher against MiniStack', () => {
  const client = createTestSqsClient();
  const unreachableClient = createTestSqsClient({ endpoint: CLOSED_PORT_ENDPOINT });
  let queues: TestQueues;
  let publisher: SqsEventPublisher;

  beforeEach(async () => {
    queues = await createTestQueues();
    publisher = new SqsEventPublisher(client, queues.urls.walletEvents);
  });

  afterAll(() => {
    client.destroy();
    unreachableClient.destroy();
  });

  it('publishes every message of a multi-block batch with group, dedup id and attributes', async () => {
    const messages = outboxMessages(12);

    const result = await publisher.publishBatch(messages);

    expect(result).toEqual({
      outcomes: messages.map((message) => ({ id: message.id, result: 'published' })),
      connectivityFailure: false,
    });
    const received = await peekMessages(client, queues.urls.walletEvents);
    const byDedupId = new Map(received.map((message) => [message.deduplicationId, message]));
    expect(byDedupId.size).toBe(messages.length);
    for (const message of messages) {
      const delivered = byDedupId.get(message.id);
      expect(delivered?.groupId).toBe(message.aggregateId);
      expect(delivered?.body).toBe(JSON.stringify(message.payload));
      expect(delivered?.attributes).toEqual({
        eventType: 'WalletBalanceChanged',
        correlationId: `corr-${message.id}`,
      });
    }
  });

  it('does not duplicate an event published twice with the same event id', async () => {
    const messages = outboxMessages(3);

    await publisher.publishBatch(messages);
    const again = await publisher.publishBatch(messages);

    expect(again.outcomes.map((outcome) => outcome.result)).toEqual([
      'published',
      'published',
      'published',
    ]);
    expect((await countMessages(client, queues.urls.walletEvents)).total).toBe(3);
  });

  it('marks only the entry refused by SQS as a permanent failure', async () => {
    const messages = outboxMessages(10);
    const refused = outboxMessage(`bad ${INVALID_SQS_CHARACTER} body`);
    messages.splice(4, 0, refused);

    const result = await publisher.publishBatch(messages);

    expect(result.connectivityFailure).toBe(false);
    expect(result.outcomes).toEqual(
      messages.map((message) =>
        message.id === refused.id
          ? {
              id: refused.id,
              result: 'failed',
              kind: 'PERMANENT',
              errorCode: 'InvalidMessageContents',
            }
          : { id: message.id, result: 'published' },
      ),
    );
    const received = await peekMessages(client, queues.urls.walletEvents);
    expect(received.map((message) => message.deduplicationId).sort()).toEqual(
      messages
        .filter((message) => message.id !== refused.id)
        .map((message) => message.id)
        .sort(),
    );
  });

  it('flags a connectivity failure and fails every entry when the queue is unreachable', async () => {
    const unreachable = new SqsEventPublisher(unreachableClient, queues.urls.walletEvents);
    const messages = outboxMessages(11);

    const result = await unreachable.publishBatch(messages);

    expect(result).toEqual({
      outcomes: messages.map((message) => ({
        id: message.id,
        result: 'failed',
        kind: 'TRANSIENT',
        errorCode: 'ECONNREFUSED',
      })),
      connectivityFailure: true,
    });
    expect((await countMessages(client, queues.urls.walletEvents)).total).toBe(0);
  });
});
