import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { ErrorClass } from '@application/errors/error-class';
import { SQS_MAX_ATTEMPTS } from '@infrastructure/messaging/sqs.client';
import { sqsErrorClassifier } from '@infrastructure/messaging/sqs-error-classifier';
import { wagerTransactionDataSchema } from '@interfaces/http/schemas/wager-transaction.schema';
import { pause, unpause } from '@test/support/containers';
import {
  WAGER_TRANSACTION_REQUESTED,
  buildEnvelope,
  countMessages,
  createTestSqsClient,
  parseEnvelope,
  peekMessages,
  publishBody,
  publishEnvelope,
  readDlq,
} from '@test/support/sqs';
import {
  TEST_MAX_RECEIVE_COUNT,
  TEST_VISIBILITY_TIMEOUT_SECONDS,
  createTestQueues,
} from '@test/support/test-queues';
import type { TestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

const QUEUE_WAIT = { timeoutMs: 10_000, intervalMs: 100 } as const;

const attributesOf = async (
  client: SQSClient,
  queueUrl: string,
): Promise<Partial<Record<string, string>>> => {
  const result = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['All'] }),
  );
  return result.Attributes ?? {};
};

const requestHandlerConfig = (client: SQSClient): unknown => {
  const handler = client.config.requestHandler;
  return handler instanceof NodeHttpHandler ? handler.httpHandlerConfigs() : undefined;
};

describe('queue helpers', () => {
  let client: SQSClient;
  let queues: TestQueues;

  beforeAll(async () => {
    client = createTestSqsClient();
    queues = await createTestQueues();
  });

  afterAll(() => {
    client.destroy();
  });

  it('creates the three queues with a unique suffix and the test redrive policy', async () => {
    const other = await createTestQueues();
    expect(other.suffix).not.toBe(queues.suffix);
    expect(queues.names).toEqual({
      wagerTransactions: `wager-transactions-${queues.suffix}.fifo`,
      wagerTransactionsDlq: `wager-transactions-dlq-${queues.suffix}.fifo`,
      walletEvents: `wallet-events-${queues.suffix}.fifo`,
    });
    expect(queues.urls.wagerTransactions).toEndWith(queues.names.wagerTransactions);
    expect(queues.urls.wagerTransactionsDlq).toEndWith(queues.names.wagerTransactionsDlq);
    expect(queues.urls.walletEvents).toEndWith(queues.names.walletEvents);

    const wager = await attributesOf(client, queues.urls.wagerTransactions);
    const dlq = await attributesOf(client, queues.urls.wagerTransactionsDlq);
    expect(wager.FifoQueue).toBe('true');
    expect(wager.ContentBasedDeduplication).toBe('false');
    expect(wager.VisibilityTimeout).toBe(String(TEST_VISIBILITY_TIMEOUT_SECONDS));
    expect(JSON.parse(wager.RedrivePolicy ?? 'null')).toEqual({
      deadLetterTargetArn: dlq.QueueArn,
      maxReceiveCount: TEST_MAX_RECEIVE_COUNT,
    });
    expect(queues.env).toMatchObject({
      WAGER_QUEUE_NAME: queues.names.wagerTransactions,
      WAGER_DLQ_NAME: queues.names.wagerTransactionsDlq,
      EVENTS_QUEUE_NAME: queues.names.walletEvents,
      CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '5',
      CONSUMER_MAX_RECEIVE_COUNT: '3',
    });
  });

  it('builds an envelope whose data passes the wager transaction data schema', () => {
    const envelope = buildEnvelope({ data: { money: { amount: '25.50', currency: 'USD' } } });
    expect(envelope.type).toBe(WAGER_TRANSACTION_REQUESTED);
    expect(envelope.messageId).toMatch(/^[\x21-\x7E]{1,128}$/);
    expect(Number.isNaN(Date.parse(envelope.occurredAt))).toBe(false);
    const parsed = wagerTransactionDataSchema(['BRL', 'USD', 'EUR']).safeParse(envelope.data);
    expect(parsed.success).toBe(true);
    expect(envelope.data.money).toEqual({ amount: '25.50', currency: 'USD' });
    expect(buildEnvelope().messageId).not.toBe(envelope.messageId);
  });

  it('publishes with the wallet as group and the message id as deduplication id', async () => {
    const own = await createTestQueues();
    const envelope = buildEnvelope();
    await publishEnvelope(client, own.urls.wagerTransactions, envelope, {
      correlationId: 'corr-1',
    });
    await publishEnvelope(client, own.urls.wagerTransactions, envelope, {
      correlationId: 'corr-2',
    });

    await waitFor(
      async () => (await countMessages(client, own.urls.wagerTransactions)).total === 1,
      QUEUE_WAIT,
    );
    const [message, ...rest] = await peekMessages(client, own.urls.wagerTransactions);
    expect(rest).toEqual([]);
    expect(message?.groupId).toBe(envelope.data.walletId);
    expect(message?.deduplicationId).toBe(envelope.messageId);
    expect(message?.attributes).toEqual({ correlationId: 'corr-1' });
    expect(message === undefined ? undefined : parseEnvelope(message)).toEqual(envelope);
    expect(await countMessages(client, own.urls.wagerTransactions)).toEqual({
      visible: 1,
      inFlight: 0,
      total: 1,
    });
  });

  it('reads the DLQ without consuming it', async () => {
    const own = await createTestQueues();
    await publishBody(client, own.urls.wagerTransactionsDlq, 'not json', {
      groupId: 'group-a',
      deduplicationId: 'dedup-a',
      attributes: { dlqReason: 'INVALID_PAYLOAD', originalMessageId: 'sqs-a' },
    });
    await publishBody(client, own.urls.wagerTransactionsDlq, 'still not json', {
      groupId: 'group-b',
      deduplicationId: 'dedup-b',
    });

    const first = await readDlq(client, own.urls.wagerTransactionsDlq);
    const second = await readDlq(client, own.urls.wagerTransactionsDlq);

    const byGroup = (group: string) => first.find((message) => message.groupId === group);
    expect(first).toHaveLength(2);
    expect(byGroup('group-a')?.attributes).toEqual({
      dlqReason: 'INVALID_PAYLOAD',
      originalMessageId: 'sqs-a',
    });
    expect(byGroup('group-a')?.body).toBe('not json');
    expect(byGroup('group-b')?.attributes).toEqual({});
    expect(second.map((message) => message.sqsMessageId).sort()).toEqual(
      first.map((message) => message.sqsMessageId).sort(),
    );
    expect(await countMessages(client, own.urls.wagerTransactionsDlq)).toEqual({
      visible: 2,
      inFlight: 0,
      total: 2,
    });
  });

  it('configures every helper client with a single attempt and a throwing request timeout', async () => {
    const fresh = createTestSqsClient({ requestTimeoutMs: 1234 });
    try {
      await countMessages(fresh, queues.urls.wagerTransactions);
      expect(SQS_MAX_ATTEMPTS).toBe(1);
      expect(await fresh.config.maxAttempts()).toBe(SQS_MAX_ATTEMPTS);
      expect(requestHandlerConfig(fresh)).toMatchObject({
        requestTimeout: 1234,
        throwOnRequestTimeout: true,
      });
    } finally {
      fresh.destroy();
    }
  });

  it('fails in time instead of hanging while MiniStack is paused', async () => {
    const quick = createTestSqsClient({ requestTimeoutMs: 500 });
    await pause('ministack');
    try {
      const startedAt = performance.now();
      const failure: unknown = await countMessages(quick, queues.urls.wagerTransactions).then(
        () => undefined,
        (error: unknown) => error,
      );
      const elapsedMs = performance.now() - startedAt;

      expect(failure instanceof Error ? failure.name : undefined).toBe('TimeoutError');
      expect(elapsedMs).toBeLessThan(3000);
      const outcome = sqsErrorClassifier.classify(failure, { shuttingDown: false });
      expect(outcome.kind === 'failure' ? outcome.error.errorClass : undefined).toBe(
        ErrorClass.Connectivity,
      );
    } finally {
      await unpause('ministack');
      quick.destroy();
    }
    expect((await countMessages(client, queues.urls.wagerTransactions)).total).toBe(0);
  });
});
