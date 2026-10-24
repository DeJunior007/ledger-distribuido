import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import type { Message, SQSClient } from '@aws-sdk/client-sqs';
import { ErrorClass } from '@application/errors/error-class';
import { LoggerPort } from '@application/ports/logger.port';
import { FailureCode } from '@domain/shared/failure-code';
import { createMetricsRegistry } from '@infrastructure/observability/metrics.registry';
import { PromMetricsAdapter } from '@infrastructure/observability/prom-metrics.adapter';
import { Uuidv7IdGenerator } from '@infrastructure/system/uuidv7-id-generator';
import { DlqMover, DlqReason } from '@interfaces/sqs/dlq-mover';
import {
  buildEnvelope,
  countMessages,
  createTestSqsClient,
  peekMessages,
  publishBody,
  publishEnvelope,
  readDlq,
} from '@test/support/sqs';
import { createTestQueues } from '@test/support/test-queues';
import type { TestQueues } from '@test/support/test-queues';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HOLD_VISIBILITY_SECONDS = 120;
const LONG_BACKOFF_SECONDS = 60;
const SHORT_VISIBILITY_SECONDS = 1;

class SilentLogger extends LoggerPort {
  info(): void {
    return undefined;
  }

  warn(): void {
    return undefined;
  }

  error(): void {
    return undefined;
  }
}

const receiveOne = async (
  client: SQSClient,
  queueUrl: string,
  visibilityTimeout: number = HOLD_VISIBILITY_SECONDS,
): Promise<Message> => {
  const result = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 1,
      VisibilityTimeout: visibilityTimeout,
      MessageAttributeNames: ['All'],
      MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
    }),
  );
  const message = result.Messages?.[0];
  if (message === undefined) {
    throw new Error(`no message received from ${queueUrl}`);
  }
  return message;
};

const missingQueueUrl = (queueUrl: string): string =>
  queueUrl.replace(/[^/]+$/, `missing-${randomUUID()}.fifo`);

describe('DlqMover', () => {
  const client = createTestSqsClient();
  const ids = new Uuidv7IdGenerator();
  const logger = new SilentLogger();

  let queues: TestQueues;
  const observability = createMetricsRegistry();

  const moverFor = (dlqUrl: string = queues.urls.wagerTransactionsDlq): DlqMover =>
    new DlqMover(
      client,
      { queueUrl: queues.urls.wagerTransactions, dlqUrl },
      ids,
      new PromMetricsAdapter(observability.metrics),
      logger,
    );

  const dlqMovedSamples = (): Promise<string> =>
    observability.registry.getSingleMetricAsString('jungle_sqs_dlq_moved_total');

  beforeEach(async () => {
    observability.metrics.sqsDlqMoved.reset();
    queues = await createTestQueues();
  });

  afterAll(() => {
    client.destroy();
  });

  it('copies the message to the dlq with the reason attributes and then deletes the original', async () => {
    const envelope = buildEnvelope();
    await publishEnvelope(client, queues.urls.wagerTransactions, envelope, {
      correlationId: 'corr-1',
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    });
    const message = await receiveOne(client, queues.urls.wagerTransactions);

    const result = await moverFor().move({
      message,
      reason: DlqReason.IdempotencyKeyConflict,
      failureCode: FailureCode.IdempotencyKeyConflict,
      backoffSeconds: LONG_BACKOFF_SECONDS,
    });

    expect(result).toEqual({ kind: 'moved', originalMessageId: envelope.messageId });
    expect(await dlqMovedSamples()).toContain(
      'jungle_sqs_dlq_moved_total{reason="IDEMPOTENCY_KEY_CONFLICT"} 1',
    );
    expect(await countMessages(client, queues.urls.wagerTransactions)).toEqual({
      visible: 0,
      inFlight: 0,
      total: 0,
    });
    const [moved, ...others] = await readDlq(client, queues.urls.wagerTransactionsDlq);
    expect(others).toHaveLength(0);
    expect(moved?.body).toBe(JSON.stringify(envelope));
    expect(moved?.groupId).toBe(envelope.data.walletId);
    expect(moved?.deduplicationId).toMatch(UUID_V7);
    expect(moved?.deduplicationId).not.toBe(envelope.messageId);
    expect(moved?.attributes).toEqual({
      correlationId: 'corr-1',
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      dlqReason: 'IDEMPOTENCY_KEY_CONFLICT',
      failureCode: 'IDEMPOTENCY_KEY_CONFLICT',
      originalMessageId: envelope.messageId,
    });
  });

  it('omits failureCode when there is none', async () => {
    const envelope = buildEnvelope();
    await publishEnvelope(client, queues.urls.wagerTransactions, envelope);
    const message = await receiveOne(client, queues.urls.wagerTransactions);

    const result = await moverFor().move({
      message,
      reason: DlqReason.ProcessingFailed,
      backoffSeconds: LONG_BACKOFF_SECONDS,
    });

    expect(result.kind).toBe('moved');
    const [moved] = await readDlq(client, queues.urls.wagerTransactionsDlq);
    expect(moved?.attributes).toEqual({
      dlqReason: 'PROCESSING_FAILED',
      originalMessageId: envelope.messageId,
    });
  });

  it('uses the SQS MessageId as originalMessageId when the body is not a readable envelope', async () => {
    const sqsMessageId = await publishBody(client, queues.urls.wagerTransactions, 'not-json{', {
      groupId: 'group-unreadable',
      deduplicationId: `dedup-${randomUUID()}`,
    });
    const message = await receiveOne(client, queues.urls.wagerTransactions);

    const result = await moverFor().move({
      message,
      reason: DlqReason.InvalidPayload,
      failureCode: FailureCode.InvalidPayload,
      backoffSeconds: LONG_BACKOFF_SECONDS,
    });

    expect(result).toEqual({ kind: 'moved', originalMessageId: sqsMessageId });
    expect((await countMessages(client, queues.urls.wagerTransactions)).total).toBe(0);
    const [moved] = await readDlq(client, queues.urls.wagerTransactionsDlq);
    expect(moved?.body).toBe('not-json{');
    expect(moved?.groupId).toBe('group-unreadable');
    expect(moved?.attributes).toEqual({
      dlqReason: 'INVALID_PAYLOAD',
      failureCode: 'INVALID_PAYLOAD',
      originalMessageId: sqsMessageId,
    });
  });

  it('gives every move its own deduplication id so a repeated move is not swallowed', async () => {
    const envelope = buildEnvelope();
    await publishEnvelope(client, queues.urls.wagerTransactions, envelope, {
      deduplicationId: `first-${randomUUID()}`,
    });
    await publishEnvelope(client, queues.urls.wagerTransactions, envelope, {
      deduplicationId: `second-${randomUUID()}`,
    });
    const mover = moverFor();

    for (let round = 0; round < 2; round += 1) {
      const message = await receiveOne(client, queues.urls.wagerTransactions);
      const result = await mover.move({
        message,
        reason: DlqReason.ProcessingFailed,
        backoffSeconds: LONG_BACKOFF_SECONDS,
      });
      expect(result.kind).toBe('moved');
    }

    const moved = await readDlq(client, queues.urls.wagerTransactionsDlq);
    expect(moved).toHaveLength(2);
    expect(new Set(moved.map((entry) => entry.deduplicationId)).size).toBe(2);
    expect(moved.every((entry) => entry.attributes.originalMessageId === envelope.messageId)).toBe(
      true,
    );
  });

  it('keeps the original and applies the backoff when the dlq send fails', async () => {
    const envelope = buildEnvelope();
    await publishEnvelope(client, queues.urls.wagerTransactions, envelope);
    const message = await receiveOne(client, queues.urls.wagerTransactions);
    expect(await countMessages(client, queues.urls.wagerTransactions)).toMatchObject({
      visible: 0,
      inFlight: 1,
    });

    const result = await moverFor(missingQueueUrl(queues.urls.wagerTransactionsDlq)).move({
      message,
      reason: DlqReason.InvalidPayload,
      backoffSeconds: 0,
    });

    expect(result.kind).toBe('retained');
    expect(await dlqMovedSamples()).not.toContain('reason=');
    expect(result.kind === 'retained' ? result.error.errorClass : undefined).toBe(
      ErrorClass.Permanent,
    );
    expect((await readDlq(client, queues.urls.wagerTransactionsDlq)).length).toBe(0);
    const [kept, ...others] = await peekMessages(client, queues.urls.wagerTransactions);
    expect(others).toHaveLength(0);
    expect(kept?.body).toBe(JSON.stringify(envelope));
    expect(kept?.receiveCount).toBe(2);
  });

  it('holds the original for the whole backoff when the dlq send fails', async () => {
    await publishEnvelope(client, queues.urls.wagerTransactions, buildEnvelope());
    const message = await receiveOne(
      client,
      queues.urls.wagerTransactions,
      SHORT_VISIBILITY_SECONDS,
    );

    const result = await moverFor(missingQueueUrl(queues.urls.wagerTransactionsDlq)).move({
      message,
      reason: DlqReason.FailedPathError,
      backoffSeconds: LONG_BACKOFF_SECONDS,
    });

    expect(result.kind).toBe('retained');
    await Bun.sleep((SHORT_VISIBILITY_SECONDS + 1) * 1000);
    expect(await countMessages(client, queues.urls.wagerTransactions)).toEqual({
      visible: 0,
      inFlight: 1,
      total: 1,
    });
  });
});
