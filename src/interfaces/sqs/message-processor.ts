import type { Message } from '@aws-sdk/client-sqs';
import { DomainError } from '@domain/shared/domain-error';
import type { FailureCode } from '@domain/shared/failure-code';
import type {
  SubmitResult,
  SubmitWagerTransactionCommand,
} from '@application/commands/submit-wager-transaction.command';
import { ApplicationError } from '@application/errors/application-error';
import { ErrorClass, TechnicalError, classifyError } from '@application/errors/error-class';
import type { HasherPort } from '@application/ports/hasher.port';
import type { LoggerPort } from '@application/ports/logger.port';
import type { MetricsPort } from '@application/ports/metrics.port';
import { TRUSTED_CHANNEL } from '@application/ports/provider-identity.port';
import type { CanonicalValue } from '@application/services/canonical-json';
import { computeInboxHash } from '@application/services/payload-hash';
import type { MarkTransactionFailedUseCase } from '@application/use-cases/mark-transaction-failed.use-case';
import type { SubmitWagerTransactionUseCase } from '@application/use-cases/submit-wager-transaction.use-case';
import { requestContext } from '@infrastructure/observability/request-context';
import { hasDuplicateJsonKey } from '@interfaces/http/json-duplicate-keys';
import type { WagerTransactionData } from '@interfaces/http/schemas/wager-transaction.schema';
import type { BreakerProbe, CircuitBreaker } from './circuit-breaker';
import { DlqReason } from './dlq-mover';
import { readEnvelopeMessageId, wagerTransactionEnvelopeSchema } from './message-envelope.schema';
import type { WagerTransactionEnvelope } from './message-envelope.schema';

export const BACKOFF_BASE_SECONDS = 2;
export const MAX_BACKOFF_SECONDS = 300;
export const CORRELATION_ID_ATTRIBUTE = 'correlationId';

export type MessageAction =
  | { readonly kind: 'ack' }
  | { readonly kind: 'delete' }
  | {
      readonly kind: 'dlq';
      readonly reason: DlqReason;
      readonly failureCode: FailureCode | undefined;
      readonly backoffSeconds: number;
    }
  | { readonly kind: 'backoff'; readonly backoffSeconds: number };

export interface MessageProcessorDependencies {
  readonly submit: Pick<SubmitWagerTransactionUseCase, 'execute'>;
  readonly markFailed: Pick<MarkTransactionFailedUseCase, 'execute'>;
  readonly hasher: HasherPort;
  readonly breaker: Pick<CircuitBreaker, 'open'>;
  readonly metrics: MetricsPort;
  readonly logger: LoggerPort;
}

export interface MessageProcessorConfig {
  readonly supportedCurrencies: readonly string[];
  readonly maxReceiveCount: number;
  readonly processingTimeoutMs: number;
}

interface Delivery {
  readonly command: SubmitWagerTransactionCommand;
  readonly receiveCount: number;
  readonly backoffSeconds: number;
}

type ResultSource = 'submission' | 'failed-path';

export const backoffSecondsFor = (receiveCount: number): number =>
  Math.min(2 ** receiveCount * BACKOFF_BASE_SECONDS, MAX_BACKOFF_SECONDS);

export const receiveCountOf = (message: Message): number => {
  const count = Number(message.Attributes?.ApproximateReceiveCount);
  return Number.isInteger(count) && count > 0 ? count : 1;
};

const correlationIdOf = (message: Message, envelope: WagerTransactionEnvelope): string => {
  const attribute = message.MessageAttributes?.[CORRELATION_ID_ATTRIBUTE]?.StringValue;
  return attribute === undefined || attribute === '' ? envelope.messageId : attribute;
};

const inboxHashInput = (data: WagerTransactionData): CanonicalValue => ({
  providerId: data.providerId,
  externalTransactionId: data.externalTransactionId,
  idempotencyKey: data.idempotencyKey,
  playerId: data.playerId,
  walletId: data.walletId,
  roundId: data.roundId,
  gameId: data.gameId,
  kind: data.kind,
  money: { amount: data.money.amount, currency: data.money.currency },
  referenceExternalTransactionId: data.referenceExternalTransactionId,
});

const failureCodeOf = (error: unknown): FailureCode | undefined =>
  error instanceof DomainError || error instanceof ApplicationError ? error.failureCode : undefined;

const technicalReasonOf = (error: unknown): string | undefined =>
  error instanceof TechnicalError ? error.reason : undefined;

const probeOf = (error: unknown): BreakerProbe =>
  error instanceof TechnicalError && error.probe !== undefined ? error.probe : 'database';

const lockConflictTypeOf = (error: unknown): 'lock_timeout' | 'version_mismatch' | undefined => {
  const reason = technicalReasonOf(error);
  return reason === 'lock_timeout' || reason === 'version_mismatch' ? reason : undefined;
};

const dlq = (
  reason: DlqReason,
  failureCode: FailureCode | undefined,
  backoffSeconds: number,
): MessageAction => ({ kind: 'dlq', reason, failureCode, backoffSeconds });

const optionalFailureCode = (failureCode: FailureCode | undefined): { failureCode?: string } =>
  failureCode === undefined ? {} : { failureCode };

export class MessageProcessor {
  private readonly envelopeSchema: ReturnType<typeof wagerTransactionEnvelopeSchema>;

  constructor(
    private readonly deps: MessageProcessorDependencies,
    private readonly config: MessageProcessorConfig,
  ) {
    this.envelopeSchema = wagerTransactionEnvelopeSchema(config.supportedCurrencies);
  }

  process(message: Message): Promise<MessageAction> {
    const receiveCount = receiveCountOf(message);
    const backoffSeconds = backoffSecondsFor(receiveCount);
    const envelope = this.parseEnvelope(message.Body);
    if (envelope === undefined) {
      return Promise.resolve(this.invalidEnvelope(message, backoffSeconds));
    }
    const command = this.commandOf(message, envelope);
    return requestContext.run(
      {
        messageId: envelope.messageId,
        providerId: command.providerId,
        walletId: command.walletId,
        correlationId: command.correlationId,
      },
      () => this.handle({ command, receiveCount, backoffSeconds }),
    );
  }

  private parseEnvelope(body: string | undefined): WagerTransactionEnvelope | undefined {
    if (body === undefined) {
      return undefined;
    }
    try {
      const document: unknown = JSON.parse(body);
      if (hasDuplicateJsonKey(body)) {
        return undefined;
      }
      const parsed = this.envelopeSchema.safeParse(document);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  private invalidEnvelope(message: Message, backoffSeconds: number): MessageAction {
    const messageId = readEnvelopeMessageId(message.Body) ?? message.MessageId;
    this.deps.logger.warn('message envelope is invalid', {
      ...(messageId === undefined ? {} : { messageId }),
      dlqReason: DlqReason.InvalidPayload,
    });
    return dlq(DlqReason.InvalidPayload, undefined, backoffSeconds);
  }

  private commandOf(
    message: Message,
    envelope: WagerTransactionEnvelope,
  ): SubmitWagerTransactionCommand {
    const { data } = envelope;
    return {
      channel: 'sqs',
      identity: TRUSTED_CHANNEL,
      providerId: data.providerId,
      externalTransactionId: data.externalTransactionId,
      idempotencyKey: data.idempotencyKey,
      playerId: data.playerId,
      walletId: data.walletId,
      roundId: data.roundId,
      gameId: data.gameId,
      kind: data.kind,
      money: { amount: data.money.amount, currency: data.money.currency },
      referenceExternalTransactionId: data.referenceExternalTransactionId,
      correlationId: correlationIdOf(message, envelope),
      causationId: envelope.messageId,
      inbox: {
        messageId: envelope.messageId,
        payloadHash: computeInboxHash(inboxHashInput(data), this.deps.hasher),
      },
    };
  }

  private async handle(delivery: Delivery): Promise<MessageAction> {
    try {
      const result = await this.withTimeout(this.deps.submit.execute(delivery.command));
      return this.actionForResult(result, delivery, 'submission');
    } catch (error) {
      return this.actionForError(error, delivery);
    }
  }

  private async withTimeout(work: Promise<SubmitResult>): Promise<SubmitResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new TechnicalError(ErrorClass.Connectivity, 'processing_timeout', { probe: 'database' }),
        );
      }, this.config.processingTimeoutMs);
    });
    try {
      return await Promise.race([work, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  private actionForResult(
    result: SubmitResult,
    delivery: Delivery,
    source: ResultSource,
  ): MessageAction {
    switch (result.kind) {
      case 'outcome':
        return source === 'failed-path' && result.httpStatus === 500 && !result.replay
          ? dlq(DlqReason.ProcessingFailed, result.body.failureCode, delivery.backoffSeconds)
          : { kind: 'ack' };
      case 'external-id-conflict':
        return result.replay
          ? { kind: 'delete' }
          : dlq(
              DlqReason.ExternalTransactionIdConflict,
              result.body.failureCode,
              delivery.backoffSeconds,
            );
      case 'idempotency-key-conflict':
        return dlq(
          DlqReason.IdempotencyKeyConflict,
          result.body.failureCode,
          delivery.backoffSeconds,
        );
      case 'inbox-payload-mismatch':
        return dlq(DlqReason.InboxPayloadMismatch, undefined, delivery.backoffSeconds);
    }
  }

  private actionForError(
    error: unknown,
    delivery: Delivery,
  ): Promise<MessageAction> | MessageAction {
    const errorClass = classifyError(error);
    if (errorClass === ErrorClass.Business) {
      this.deps.logger.warn('business error raised while processing message', {
        errorClass,
        ...optionalFailureCode(failureCodeOf(error)),
      });
      return { kind: 'delete' };
    }
    if (errorClass === ErrorClass.Validation) {
      return dlq(DlqReason.InvalidPayload, failureCodeOf(error), delivery.backoffSeconds);
    }
    if (errorClass === ErrorClass.Transient) {
      return this.retryTransient(error, delivery);
    }
    if (errorClass === ErrorClass.Connectivity) {
      return this.retryConnectivity(error, delivery);
    }
    return this.handleDeterministic(error, delivery);
  }

  private retryTransient(error: unknown, delivery: Delivery): MessageAction {
    const lockConflict = lockConflictTypeOf(error);
    if (lockConflict !== undefined) {
      this.deps.metrics.lockConflict(lockConflict);
    }
    this.deps.metrics.sqsRetry('transient');
    return this.deferred(ErrorClass.Transient, error, delivery);
  }

  private retryConnectivity(error: unknown, delivery: Delivery): MessageAction {
    this.deps.breaker.open(probeOf(error));
    this.deps.metrics.sqsRetry('connectivity');
    return this.deferred(ErrorClass.Connectivity, error, delivery);
  }

  private async handleDeterministic(error: unknown, delivery: Delivery): Promise<MessageAction> {
    if (delivery.receiveCount < this.config.maxReceiveCount) {
      this.deps.metrics.sqsRetry('deterministic');
      return this.deferred(ErrorClass.Deterministic, error, delivery);
    }
    try {
      const result = await this.deps.markFailed.execute(delivery.command);
      return this.actionForResult(result, delivery, 'failed-path');
    } catch (failure) {
      const reason = technicalReasonOf(failure);
      this.deps.logger.error('failed path raised an error', {
        errorClass: classifyError(failure),
        ...(reason === undefined ? {} : { reason }),
        dlqReason: DlqReason.FailedPathError,
        attempt: delivery.receiveCount,
      });
      return dlq(DlqReason.FailedPathError, undefined, delivery.backoffSeconds);
    }
  }

  private deferred(errorClass: ErrorClass, error: unknown, delivery: Delivery): MessageAction {
    const reason = technicalReasonOf(error);
    this.deps.logger.warn('message processing deferred', {
      errorClass,
      ...(reason === undefined ? {} : { reason }),
      attempt: delivery.receiveCount,
    });
    return { kind: 'backoff', backoffSeconds: delivery.backoffSeconds };
  }
}
