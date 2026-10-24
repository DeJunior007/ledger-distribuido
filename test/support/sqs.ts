import { randomUUID } from 'node:crypto';
import {
  ChangeMessageVisibilityCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import type { Message, MessageAttributeValue, SQSClient } from '@aws-sdk/client-sqs';
import { createSqsClient } from '@infrastructure/messaging/sqs.client';
import type { WagerTransactionData } from '@interfaces/http/schemas/wager-transaction.schema';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { WAGER_TRANSACTION_REQUESTED } from '@interfaces/sqs/message-envelope.schema';
import type { WagerTransactionEnvelope } from '@interfaces/sqs/message-envelope.schema';
import { TEST_SQS_REQUEST_TIMEOUT_MS, testSqsClientConfig } from './test-queues';

export { WAGER_TRANSACTION_REQUESTED };
export type { WagerTransactionEnvelope };

const RECEIVE_BATCH_SIZE = 10;
const PEEK_VISIBILITY_TIMEOUT_SECONDS = 30;
const MAX_PEEK_ROUNDS = 100;

export interface EnvelopeOverrides {
  readonly messageId?: string;
  readonly occurredAt?: string;
  readonly data?: Partial<WagerTransactionData>;
}

export interface TestSqsClientOptions {
  readonly endpoint?: string;
  readonly requestTimeoutMs?: number;
}

export interface PublishOptions {
  readonly groupId?: string;
  readonly deduplicationId?: string;
  readonly correlationId?: string;
  readonly traceparent?: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

export interface PublishBodyOptions {
  readonly groupId: string;
  readonly deduplicationId: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

export interface ReceivedTestMessage {
  readonly sqsMessageId: string;
  readonly body: string;
  readonly groupId: string | undefined;
  readonly deduplicationId: string | undefined;
  readonly receiveCount: number;
  readonly attributes: Readonly<Record<string, string>>;
}

export interface QueueMessageCounts {
  readonly visible: number;
  readonly inFlight: number;
  readonly total: number;
}

export class SqsHelperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqsHelperError';
  }
}

export const createTestSqsClient = (options: TestSqsClientOptions = {}): SQSClient => {
  const base = testSqsClientConfig();
  return createSqsClient(
    { ...base, SQS_ENDPOINT: options.endpoint ?? base.SQS_ENDPOINT },
    options.requestTimeoutMs ?? TEST_SQS_REQUEST_TIMEOUT_MS,
  );
};

export const buildEnvelope = (overrides: EnvelopeOverrides = {}): WagerTransactionEnvelope => {
  const id = randomUUID();
  const data: WagerTransactionData = {
    providerId: 'provider-test',
    externalTransactionId: `ext-${id}`,
    playerId: randomUUID(),
    walletId: randomUUID(),
    roundId: `round-${id}`,
    gameId: 'game-test',
    kind: WagerTransactionKind.Bet,
    money: { amount: '10.00', currency: 'BRL' },
    idempotencyKey: `idem-${id}`,
    ...overrides.data,
  };
  return {
    messageId: overrides.messageId ?? `msg-${id}`,
    type: WAGER_TRANSACTION_REQUESTED,
    occurredAt: overrides.occurredAt ?? new Date().toISOString(),
    data,
  };
};

const toMessageAttributes = (
  attributes: Readonly<Record<string, string>>,
): Record<string, MessageAttributeValue> =>
  Object.fromEntries(
    Object.entries(attributes).map(([name, value]) => [
      name,
      { DataType: 'String', StringValue: value },
    ]),
  );

const requireMessageId = (messageId: string | undefined): string => {
  if (messageId === undefined) {
    throw new SqsHelperError('SendMessage returned no MessageId');
  }
  return messageId;
};

export const publishBody = async (
  client: SQSClient,
  queueUrl: string,
  body: string,
  options: PublishBodyOptions,
): Promise<string> => {
  const attributes = options.attributes ?? {};
  const result = await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: options.groupId,
      MessageDeduplicationId: options.deduplicationId,
      ...(Object.keys(attributes).length > 0
        ? { MessageAttributes: toMessageAttributes(attributes) }
        : {}),
    }),
  );
  return requireMessageId(result.MessageId);
};

const envelopeAttributes = (options: PublishOptions): Record<string, string> => ({
  ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
  ...(options.traceparent === undefined ? {} : { traceparent: options.traceparent }),
  ...options.attributes,
});

export const publishEnvelope = (
  client: SQSClient,
  queueUrl: string,
  envelope: WagerTransactionEnvelope,
  options: PublishOptions = {},
): Promise<string> =>
  publishBody(client, queueUrl, JSON.stringify(envelope), {
    groupId: options.groupId ?? envelope.data.walletId,
    deduplicationId: options.deduplicationId ?? envelope.messageId,
    attributes: envelopeAttributes(options),
  });

const stringAttributes = (message: Message): Record<string, string> => {
  const attributes: Record<string, string> = {};
  for (const [name, value] of Object.entries(message.MessageAttributes ?? {})) {
    if (value.StringValue !== undefined) {
      attributes[name] = value.StringValue;
    }
  }
  return attributes;
};

const toReceivedMessage = (message: Message): ReceivedTestMessage => {
  if (message.MessageId === undefined || message.Body === undefined) {
    throw new SqsHelperError('ReceiveMessage returned a message without MessageId or Body');
  }
  return {
    sqsMessageId: message.MessageId,
    body: message.Body,
    groupId: message.Attributes?.MessageGroupId,
    deduplicationId: message.Attributes?.MessageDeduplicationId,
    receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? '0'),
    attributes: stringAttributes(message),
  };
};

const receiveBatch = async (client: SQSClient, queueUrl: string): Promise<Message[]> => {
  const result = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: RECEIVE_BATCH_SIZE,
      VisibilityTimeout: PEEK_VISIBILITY_TIMEOUT_SECONDS,
      WaitTimeSeconds: 0,
      MessageAttributeNames: ['All'],
      MessageSystemAttributeNames: ['All'],
    }),
  );
  return result.Messages ?? [];
};

const releaseMessage = async (
  client: SQSClient,
  queueUrl: string,
  message: Message,
): Promise<void> => {
  if (message.ReceiptHandle === undefined) {
    return;
  }
  await client.send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: message.ReceiptHandle,
      VisibilityTimeout: 0,
    }),
  );
};

export const peekMessages = async (
  client: SQSClient,
  queueUrl: string,
): Promise<ReceivedTestMessage[]> => {
  const received: Message[] = [];
  try {
    for (let round = 0; round < MAX_PEEK_ROUNDS; round += 1) {
      const batch = await receiveBatch(client, queueUrl);
      if (batch.length === 0) {
        break;
      }
      received.push(...batch);
    }
  } finally {
    await Promise.all(received.map((message) => releaseMessage(client, queueUrl, message)));
  }
  return received.map(toReceivedMessage);
};

export const readDlq = (client: SQSClient, dlqUrl: string): Promise<ReceivedTestMessage[]> =>
  peekMessages(client, dlqUrl);

const countAttribute = (value: string | undefined): number => Number(value ?? '0');

export const countMessages = async (
  client: SQSClient,
  queueUrl: string,
): Promise<QueueMessageCounts> => {
  const result = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  const visible = countAttribute(result.Attributes?.ApproximateNumberOfMessages);
  const inFlight = countAttribute(result.Attributes?.ApproximateNumberOfMessagesNotVisible);
  return { visible, inFlight, total: visible + inFlight };
};

export const parseEnvelope = (message: ReceivedTestMessage): unknown => JSON.parse(message.body);
