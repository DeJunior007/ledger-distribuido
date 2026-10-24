import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import type { Message, MessageAttributeValue, SQSClient } from '@aws-sdk/client-sqs';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import type { IdGeneratorPort } from '@application/ports/id-generator.port';
import type { LoggerPort } from '@application/ports/logger.port';
import type { MetricsPort } from '@application/ports/metrics.port';
import { sqsErrorClassifier } from '@infrastructure/messaging/sqs-error-classifier';
import { readEnvelopeMessageId } from './message-envelope.schema';

export enum DlqReason {
  InvalidPayload = 'INVALID_PAYLOAD',
  IdempotencyKeyConflict = 'IDEMPOTENCY_KEY_CONFLICT',
  ExternalTransactionIdConflict = 'EXTERNAL_TRANSACTION_ID_CONFLICT',
  InboxPayloadMismatch = 'INBOX_PAYLOAD_MISMATCH',
  ProcessingFailed = 'PROCESSING_FAILED',
  FailedPathError = 'FAILED_PATH_ERROR',
}

export const DLQ_REASON_ATTRIBUTE = 'dlqReason';
export const FAILURE_CODE_ATTRIBUTE = 'failureCode';
export const ORIGINAL_MESSAGE_ID_ATTRIBUTE = 'originalMessageId';

export const DLQ_ATTRIBUTE_NAMES: readonly string[] = [
  DLQ_REASON_ATTRIBUTE,
  FAILURE_CODE_ATTRIBUTE,
  ORIGINAL_MESSAGE_ID_ATTRIBUTE,
];

export interface DlqMoverQueues {
  readonly queueUrl: string;
  readonly dlqUrl: string;
}

export interface DlqMoveRequest {
  readonly message: Message;
  readonly reason: DlqReason;
  readonly failureCode?: string | undefined;
  readonly backoffSeconds: number;
}

export type DlqMoveResult =
  | { readonly kind: 'moved'; readonly originalMessageId: string }
  | { readonly kind: 'retained'; readonly error: TechnicalError };

const stringAttribute = (value: string): MessageAttributeValue => ({
  DataType: 'String',
  StringValue: value,
});

const copyAttribute = (value: MessageAttributeValue): MessageAttributeValue => ({
  DataType: value.DataType,
  ...(value.StringValue === undefined ? {} : { StringValue: value.StringValue }),
  ...(value.BinaryValue === undefined ? {} : { BinaryValue: value.BinaryValue }),
});

const originalAttributes = (message: Message): Record<string, MessageAttributeValue> =>
  Object.fromEntries(
    Object.entries(message.MessageAttributes ?? {}).map(([name, value]) => [
      name,
      copyAttribute(value),
    ]),
  );

const classifyFailure = (cause: unknown): TechnicalError => {
  const outcome = sqsErrorClassifier.classify(cause, { shuttingDown: false });
  return outcome.kind === 'failure'
    ? outcome.error
    : new TechnicalError(ErrorClass.Transient, 'queue_transient', { cause });
};

const errorFields = (cause: unknown): { errorClass: string; reason: string } => {
  const error = classifyFailure(cause);
  return { errorClass: error.errorClass, reason: error.reason };
};

const originalMessageIdOf = (message: Message): string =>
  readEnvelopeMessageId(message.Body) ?? message.MessageId ?? '';

export class DlqMover {
  constructor(
    private readonly client: SQSClient,
    private readonly queues: DlqMoverQueues,
    private readonly ids: IdGeneratorPort,
    private readonly metrics: MetricsPort,
    private readonly logger: LoggerPort,
  ) {}

  async move(request: DlqMoveRequest): Promise<DlqMoveResult> {
    const { message, reason, failureCode } = request;
    const originalMessageId = originalMessageIdOf(message);
    try {
      await this.client.send(
        new SendMessageCommand({
          QueueUrl: this.queues.dlqUrl,
          MessageBody: message.Body,
          MessageGroupId: message.Attributes?.MessageGroupId,
          MessageDeduplicationId: this.ids.next(),
          MessageAttributes: {
            ...originalAttributes(message),
            [DLQ_REASON_ATTRIBUTE]: stringAttribute(reason),
            ...(failureCode === undefined
              ? {}
              : { [FAILURE_CODE_ATTRIBUTE]: stringAttribute(failureCode) }),
            [ORIGINAL_MESSAGE_ID_ATTRIBUTE]: stringAttribute(originalMessageId),
          },
        }),
      );
    } catch (cause) {
      return this.retain(request, originalMessageId, cause);
    }
    this.metrics.sqsDlqMoved(reason);
    this.logger.warn('message moved to dlq', {
      messageId: originalMessageId,
      dlqReason: reason,
      ...(failureCode === undefined ? {} : { failureCode }),
    });
    await this.deleteOriginal(message, originalMessageId);
    return { kind: 'moved', originalMessageId };
  }

  private async retain(
    request: DlqMoveRequest,
    originalMessageId: string,
    cause: unknown,
  ): Promise<DlqMoveResult> {
    const error = classifyFailure(cause);
    this.logger.warn('dlq move failed', {
      messageId: originalMessageId,
      dlqReason: request.reason,
      errorClass: error.errorClass,
      reason: error.reason,
    });
    await this.changeVisibility(request.message, originalMessageId, request.backoffSeconds);
    return { kind: 'retained', error };
  }

  private async deleteOriginal(message: Message, originalMessageId: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteMessageCommand({
          QueueUrl: this.queues.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    } catch (cause) {
      this.logger.warn('delete after dlq move failed', {
        messageId: originalMessageId,
        ...errorFields(cause),
      });
    }
  }

  private async changeVisibility(
    message: Message,
    originalMessageId: string,
    backoffSeconds: number,
  ): Promise<void> {
    try {
      await this.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.queues.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: backoffSeconds,
        }),
      );
    } catch (cause) {
      this.logger.warn('visibility change after failed dlq move failed', {
        messageId: originalMessageId,
        ...errorFields(cause),
      });
    }
  }
}
