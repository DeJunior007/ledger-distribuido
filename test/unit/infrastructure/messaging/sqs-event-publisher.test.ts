import { describe, expect, it } from 'bun:test';
import { SQSClient } from '@aws-sdk/client-sqs';
import type {
  SendMessageBatchCommandOutput,
  SendMessageBatchRequestEntry,
  ServiceInputTypes,
} from '@aws-sdk/client-sqs';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import { OutboxMessage } from '@domain/messaging/outbox-message';
import {
  MISSING_BATCH_RESULT_CODE,
  SqsEventPublisher,
} from '@infrastructure/messaging/sqs-event-publisher';

const QUEUE_URL = 'http://sqs.local/000000000000/wallet-events.fifo';
const RESPONSE_DELAY_MS = 20;

type Responder = (
  entries: SendMessageBatchRequestEntry[],
) => Promise<SendMessageBatchCommandOutput>;

interface StubbedSqs {
  readonly client: SQSClient;
  readonly requests: SendMessageBatchRequestEntry[][];
  readonly maxInFlight: () => number;
}

const metadata = { httpStatusCode: 200 };

const allSuccessful = (entries: SendMessageBatchRequestEntry[]): SendMessageBatchCommandOutput => ({
  $metadata: metadata,
  Successful: entries.map((entry) => ({
    Id: entry.Id,
    MessageId: `sqs-${entry.Id ?? ''}`,
    MD5OfMessageBody: 'md5',
  })),
  Failed: [],
});

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const entriesOf = (input: ServiceInputTypes): SendMessageBatchRequestEntry[] => {
  if (!('QueueUrl' in input) || input.QueueUrl !== QUEUE_URL || !('Entries' in input)) {
    throw new TypeError('unexpected SQS command');
  }
  return (input.Entries ?? []).filter(
    (entry): entry is SendMessageBatchRequestEntry => 'MessageBody' in entry,
  );
};

const stubbedSqs = (respond: Responder): StubbedSqs => {
  const client = new SQSClient({
    endpoint: 'http://127.0.0.1:1',
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    maxAttempts: 1,
  });
  const requests: SendMessageBatchRequestEntry[][] = [];
  let inFlight = 0;
  let peak = 0;
  client.middlewareStack.add(
    () => async (args) => {
      const entries = entriesOf(args.input);
      requests.push(entries);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await delay(RESPONSE_DELAY_MS);
        return { output: await respond(entries), response: {} };
      } finally {
        inFlight -= 1;
      }
    },
    { step: 'initialize', name: 'handBuiltSendMessageBatchResponse' },
  );
  return { client, requests, maxInFlight: () => peak };
};

const respondWith =
  (build: (entries: SendMessageBatchRequestEntry[]) => SendMessageBatchCommandOutput): Responder =>
  (entries) =>
    Promise.resolve(build(entries));

const failWith =
  (error: Error): Responder =>
  () =>
    Promise.reject(error);

const outboxMessage = (
  index: number,
  payload?: Readonly<Record<string, unknown>>,
): OutboxMessage => {
  const id = `0192f000-0000-7000-8000-${String(index).padStart(12, '0')}`;
  const aggregateId = `0192f000-0000-7000-9000-${String(index).padStart(12, '0')}`;
  const occurredAt = new Date('2026-10-24T12:00:00.000Z');
  return OutboxMessage.rehydrate({
    id,
    aggregateId,
    eventType: 'WalletBalanceChanged',
    payload: payload ?? {
      eventId: id,
      eventType: 'WalletBalanceChanged',
      aggregateId,
      correlationId: `corr-${String(index)}`,
      occurredAt: occurredAt.toISOString(),
      version: 1,
      data: { walletId: aggregateId, balance: { amount: '10.00', currency: 'BRL' } },
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

const outboxMessages = (count: number, offset = 0): OutboxMessage[] =>
  Array.from({ length: count }, (_, index) => outboxMessage(offset + index));

const awsError = (name: string, httpStatusCode: number): Error =>
  Object.assign(new Error(`${name} raised`), { name, $metadata: { httpStatusCode } });

const networkError = (): Error =>
  Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });

describe('SqsEventPublisher', () => {
  it('returns no outcomes and sends nothing for an empty batch', async () => {
    const sqs = stubbedSqs(respondWith(allSuccessful));
    const publisher = new SqsEventPublisher(sqs.client, QUEUE_URL);

    const result = await publisher.publishBatch([]);

    expect(result).toEqual({ outcomes: [], connectivityFailure: false });
    expect(sqs.requests).toEqual([]);
  });

  it('builds each entry from the outbox message', async () => {
    const sqs = stubbedSqs(respondWith(allSuccessful));
    const publisher = new SqsEventPublisher(sqs.client, QUEUE_URL);
    const messages = outboxMessages(2);

    await publisher.publishBatch(messages);

    expect(sqs.requests).toEqual([
      messages.map((message, index) => ({
        Id: String(index),
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: 'WalletBalanceChanged' },
          correlationId: { DataType: 'String', StringValue: `corr-${String(index)}` },
        },
      })),
    ]);
  });

  it('omits the correlationId attribute when the payload carries none', async () => {
    const sqs = stubbedSqs(respondWith(allSuccessful));
    const publisher = new SqsEventPublisher(sqs.client, QUEUE_URL);

    await publisher.publishBatch([outboxMessage(0, { eventType: 'WalletBalanceChanged' })]);

    expect(sqs.requests[0]?.[0]?.MessageAttributes).toEqual({
      eventType: { DataType: 'String', StringValue: 'WalletBalanceChanged' },
    });
  });

  it('splits the batch into blocks of ten sent in parallel', async () => {
    const sqs = stubbedSqs(respondWith(allSuccessful));
    const publisher = new SqsEventPublisher(sqs.client, QUEUE_URL);
    const messages = outboxMessages(23);

    const result = await publisher.publishBatch(messages);

    expect(sqs.requests.map((entries) => entries.length).sort()).toEqual([10, 10, 3].sort());
    expect(
      sqs.requests
        .flat()
        .map((entry) => entry.MessageDeduplicationId)
        .sort(),
    ).toEqual(messages.map((message) => message.id).sort());
    expect(sqs.maxInFlight()).toBe(3);
    expect(result).toEqual({
      outcomes: messages.map((message) => ({ id: message.id, result: 'published' })),
      connectivityFailure: false,
    });
  });

  it('maps hand-built Failed entries by SenderFault and keeps the SQS code', async () => {
    const sqs = stubbedSqs(
      respondWith(() => ({
        $metadata: metadata,
        Successful: [{ Id: '0', MessageId: 'sqs-0', MD5OfMessageBody: 'md5' }],
        Failed: [
          { Id: '1', SenderFault: true, Code: 'InvalidMessageContents', Message: 'bad body' },
          { Id: '2', SenderFault: false, Code: 'InternalError', Message: 'try again' },
        ],
      })),
    );
    const publisher = new SqsEventPublisher(sqs.client, QUEUE_URL);
    const [first, second, third] = outboxMessages(3);
    if (first === undefined || second === undefined || third === undefined) {
      throw new TypeError('expected three messages');
    }

    const result = await publisher.publishBatch([first, second, third]);

    expect(result).toEqual({
      outcomes: [
        { id: first.id, result: 'published' },
        {
          id: second.id,
          result: 'failed',
          kind: 'PERMANENT',
          errorCode: 'InvalidMessageContents',
        },
        { id: third.id, result: 'failed', kind: 'TRANSIENT', errorCode: 'InternalError' },
      ],
      connectivityFailure: false,
    });
  });

  it('treats an entry missing from the response as a transient failure', async () => {
    const sqs = stubbedSqs(
      respondWith(() => ({
        $metadata: metadata,
        Successful: [{ Id: '0', MessageId: 'sqs-0', MD5OfMessageBody: 'md5' }],
        Failed: [],
      })),
    );
    const publisher = new SqsEventPublisher(sqs.client, QUEUE_URL);
    const messages = outboxMessages(2);

    const result = await publisher.publishBatch(messages);

    expect(result.outcomes[1]).toEqual({
      id: messages[1]?.id ?? '',
      result: 'failed',
      kind: 'TRANSIENT',
      errorCode: MISSING_BATCH_RESULT_CODE,
    });
  });

  it('fails every entry of the block and flags connectivity on a network error', async () => {
    const sqs = stubbedSqs(failWith(networkError()));
    const publisher = new SqsEventPublisher(sqs.client, QUEUE_URL);
    const messages = outboxMessages(12);

    const result = await publisher.publishBatch(messages);

    expect(result).toEqual({
      outcomes: messages.map((message) => ({
        id: message.id,
        result: 'failed',
        kind: 'TRANSIENT',
        errorCode: 'ECONNREFUSED',
      })),
      connectivityFailure: true,
    });
  });

  it('keeps the outcomes of a healthy block when another block fails', async () => {
    const messages = outboxMessages(11);
    const sqs = stubbedSqs((entries) =>
      entries.length === 1
        ? Promise.reject(awsError('ThrottlingException', 400))
        : Promise.resolve(allSuccessful(entries)),
    );
    const publisher = new SqsEventPublisher(sqs.client, QUEUE_URL);

    const result = await publisher.publishBatch(messages);

    expect(result.connectivityFailure).toBe(false);
    expect(result.outcomes).toEqual([
      ...messages.slice(0, 10).map((message) => ({ id: message.id, result: 'published' as const })),
      {
        id: messages[10]?.id ?? '',
        result: 'failed',
        kind: 'TRANSIENT',
        errorCode: 'ThrottlingException',
      },
    ]);
  });

  it.each([
    ['QueueDoesNotExist', 400, 'PERMANENT'],
    ['BatchRequestTooLong', 400, 'TRANSIENT'],
    ['InternalFailure', 500, 'TRANSIENT'],
  ] as const)('classifies a block error %s with status %p as %s', async (name, status, kind) => {
    const sqs = stubbedSqs(failWith(awsError(name, status)));
    const publisher = new SqsEventPublisher(sqs.client, QUEUE_URL);
    const messages = outboxMessages(2);

    const result = await publisher.publishBatch(messages);

    expect(result).toEqual({
      outcomes: messages.map((message) => ({
        id: message.id,
        result: 'failed',
        kind,
        errorCode: name,
      })),
      connectivityFailure: false,
    });
  });

  it('raises a deterministic error and sends nothing when the batch cannot be built', async () => {
    const sqs = stubbedSqs(respondWith(allSuccessful));
    const publisher = new SqsEventPublisher(sqs.client, QUEUE_URL);
    const messages = [...outboxMessages(10), outboxMessage(10, { amount: 1n })];

    let caught: unknown;
    try {
      await publisher.publishBatch(messages);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TechnicalError);
    expect(caught).toMatchObject({ errorClass: ErrorClass.Deterministic, reason: 'deterministic' });
    expect(sqs.requests).toEqual([]);
  });
});
