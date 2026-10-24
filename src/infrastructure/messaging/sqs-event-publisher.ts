import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import type {
  BatchResultErrorEntry,
  MessageAttributeValue,
  SQSClient,
  SendMessageBatchRequestEntry,
  SendMessageBatchResult,
} from '@aws-sdk/client-sqs';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import { EventPublisherPort } from '@application/ports/event-publisher.port';
import type { PublishOutcome } from '@application/ports/event-publisher.port';
import { chunk } from '@application/services/chunk';
import type { OutboxMessage } from '@domain/messaging/outbox-message';
import { sqsErrorClassifier } from './sqs-error-classifier';

export const SQS_PUBLISH_BATCH_SIZE = 10;
export const MISSING_BATCH_RESULT_CODE = 'MissingBatchResultEntry';

export interface PublishBatchResult {
  outcomes: PublishOutcome[];
  connectivityFailure: boolean;
}

interface PreparedBlock {
  readonly messages: readonly OutboxMessage[];
  readonly entries: SendMessageBatchRequestEntry[];
}

type FailureKind = 'TRANSIENT' | 'PERMANENT';

const stringAttribute = (value: string): MessageAttributeValue => ({
  DataType: 'String',
  StringValue: value,
});

const correlationIdOf = (message: OutboxMessage): string | undefined => {
  const value = message.payload.correlationId;
  return typeof value === 'string' && value !== '' ? value : undefined;
};

const attributesOf = (message: OutboxMessage): Record<string, MessageAttributeValue> => {
  const correlationId = correlationIdOf(message);
  return {
    eventType: stringAttribute(message.eventType),
    ...(correlationId === undefined ? {} : { correlationId: stringAttribute(correlationId) }),
  };
};

const toEntry = (message: OutboxMessage, index: number): SendMessageBatchRequestEntry => ({
  Id: String(index),
  MessageBody: JSON.stringify(message.payload),
  MessageGroupId: message.aggregateId,
  MessageDeduplicationId: message.id,
  MessageAttributes: attributesOf(message),
});

const prepareBlock = (messages: readonly OutboxMessage[]): PreparedBlock => {
  try {
    return { messages, entries: messages.map(toEntry) };
  } catch (cause) {
    throw new TechnicalError(ErrorClass.Deterministic, 'deterministic', { cause });
  }
};

const kindOf = (error: TechnicalError): FailureKind =>
  error.errorClass === ErrorClass.Permanent ? 'PERMANENT' : 'TRANSIENT';

const stringProperty = (target: object, key: string): string | undefined => {
  const value: unknown = Reflect.get(target, key);
  return typeof value === 'string' && value !== '' ? value : undefined;
};

const errorCodeOf = (cause: unknown, classified: TechnicalError): string => {
  if (!(cause instanceof Error)) {
    return classified.reason;
  }
  const namedCode = cause.name === 'Error' ? undefined : cause.name;
  return (
    stringProperty(cause, 'Code') ?? namedCode ?? stringProperty(cause, 'code') ?? classified.reason
  );
};

const classifyBlockError = (cause: unknown): TechnicalError => {
  const outcome = sqsErrorClassifier.classify(cause, { shuttingDown: false });
  return outcome.kind === 'failure'
    ? outcome.error
    : new TechnicalError(ErrorClass.Transient, 'queue_transient', { cause });
};

const blockFailure = (block: PreparedBlock, cause: unknown): PublishBatchResult => {
  const classified = classifyBlockError(cause);
  const kind = kindOf(classified);
  const errorCode = errorCodeOf(cause, classified);
  return {
    outcomes: block.messages.map((message) => ({
      id: message.id,
      result: 'failed',
      kind,
      errorCode,
    })),
    connectivityFailure: classified.errorClass === ErrorClass.Connectivity,
  };
};

const entryFailure = (id: string, entry: BatchResultErrorEntry): PublishOutcome => {
  const classified = sqsErrorClassifier.classifyBatchEntry(entry);
  return {
    id,
    result: 'failed',
    kind: kindOf(classified),
    errorCode: entry.Code ?? classified.reason,
  };
};

const blockOutcomes = (
  block: PreparedBlock,
  response: SendMessageBatchResult,
): PublishBatchResult => {
  const successful = new Set((response.Successful ?? []).map((entry) => entry.Id));
  const failed = new Map((response.Failed ?? []).map((entry) => [entry.Id, entry]));
  const outcomes = block.messages.map((message, index): PublishOutcome => {
    const entryId = String(index);
    if (successful.has(entryId)) {
      return { id: message.id, result: 'published' };
    }
    const failure = failed.get(entryId);
    if (failure !== undefined) {
      return entryFailure(message.id, failure);
    }
    return {
      id: message.id,
      result: 'failed',
      kind: 'TRANSIENT',
      errorCode: MISSING_BATCH_RESULT_CODE,
    };
  });
  return { outcomes, connectivityFailure: false };
};

export class SqsEventPublisher extends EventPublisherPort {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {
    super();
  }

  async publishBatch(messages: OutboxMessage[]): Promise<PublishBatchResult> {
    const blocks = chunk(messages, SQS_PUBLISH_BATCH_SIZE).map(prepareBlock);
    const results = await Promise.all(blocks.map((block) => this.sendBlock(block)));
    return {
      outcomes: results.flatMap((result) => result.outcomes),
      connectivityFailure: results.some((result) => result.connectivityFailure),
    };
  }

  private async sendBlock(block: PreparedBlock): Promise<PublishBatchResult> {
    let response: SendMessageBatchResult;
    try {
      response = await this.client.send(
        new SendMessageBatchCommand({ QueueUrl: this.queueUrl, Entries: block.entries }),
      );
    } catch (cause) {
      return blockFailure(block, cause);
    }
    return blockOutcomes(block, response);
  }
}
