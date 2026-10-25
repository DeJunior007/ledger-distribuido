import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import type { Message, SQSClient } from '@aws-sdk/client-sqs';
import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import { context } from '@opentelemetry/api';
import { z } from 'zod';
import { ErrorClass, TechnicalError, classifyError } from '@application/errors/error-class';
import type { LogFields, LoggerPort } from '@application/ports/logger.port';
import type { TracerPort } from '@application/ports/tracer.port';
import type { RecordAuditedEventUseCase } from '@application/use-cases/record-audited-event.use-case';
import { sqsErrorClassifier } from '@infrastructure/messaging/sqs-error-classifier';
import { requestContext } from '@infrastructure/observability/request-context';
import type { RequestContext } from '@infrastructure/observability/request-context';
import { NoopTracer } from '@infrastructure/system/noop-tracer';
import type { CircuitBreaker } from '@interfaces/sqs/circuit-breaker';
import {
  SQS_PROCESS_SPAN,
  TRACEPARENT_MESSAGE_ATTRIBUTE,
  traceContextOf,
} from '@interfaces/sqs/wager-transaction.consumer';

export const EVENTS_AUDIT_COMPONENT = 'events-audit';
export const EVENTS_AUDIT_RECEIVE_BATCH_SIZE = 10;
export const EVENTS_AUDIT_DRAIN_TIMEOUT_MS = 10_000;
export const EVENTS_AUDIT_RECEIVE_RETRY_MS = 1_000;

export const AUDITED_EVENT_TYPES = [
  'WagerTransactionProcessed',
  'WagerTransactionRejected',
  'WalletBalanceChanged',
  'WagerTransactionPendingReference',
  'WagerTransactionFailed',
] as const;

export const auditedEventEnvelopeSchema = z.object({
  eventId: z.string().uuid(),
  eventType: z.enum(AUDITED_EVENT_TYPES),
  version: z.literal(1),
  aggregateId: z.string().min(1),
  correlationId: z.string().min(1),
  causationId: z.string().min(1).optional(),
  occurredAt: z.string().datetime({ offset: true }),
  data: z.record(z.string(), z.unknown()),
});

export type AuditedEventEnvelope = z.infer<typeof auditedEventEnvelopeSchema>;

export interface EventsAuditConsumerDependencies {
  readonly receiveClient: SQSClient;
  readonly client: SQSClient;
  readonly queueUrl: string;
  readonly recordAuditedEvent: Pick<RecordAuditedEventUseCase, 'execute'>;
  readonly breaker: Pick<CircuitBreaker, 'isOpen' | 'open' | 'waitUntilClosed'>;
  readonly logger: LoggerPort;
  readonly tracer?: TracerPort;
}

export interface EventsAuditConsumerSettings {
  readonly waitTimeSeconds: number;
  readonly visibilityTimeoutSeconds: number;
}

export const parseAuditedEvent = (body: string): AuditedEventEnvelope | undefined => {
  try {
    const parsed = auditedEventEnvelopeSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

const messageFields = (message: Message): LogFields =>
  message.MessageId === undefined ? {} : { messageId: message.MessageId };

const spanAttributesOf = (message: Message): Readonly<Record<string, string>> =>
  message.MessageId === undefined ? {} : { messageId: message.MessageId };

const messageContext = (
  message: Message,
  envelope: AuditedEventEnvelope,
): Partial<RequestContext> => ({
  ...(message.MessageId === undefined ? {} : { messageId: message.MessageId }),
  correlationId: envelope.correlationId,
  walletId: envelope.aggregateId,
  component: EVENTS_AUDIT_COMPONENT,
});

const technicalFields = (error: unknown): LogFields =>
  error instanceof TechnicalError
    ? { errorClass: error.errorClass, reason: error.reason }
    : { errorClass: classifyError(error) };

const pause = async (ms: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) {
    return;
  }
  const done: PromiseWithResolvers<void> = Promise.withResolvers();
  const onAbort = (): void => {
    done.resolve();
  };
  const timer = setTimeout(onAbort, ms);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await done.promise;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
};

const settleWithin = async (work: Promise<void>, ms: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
};

export class EventsAuditConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly abort = new AbortController();
  private readonly inFlight = new Map<string, LogFields>();
  private readonly tracer: TracerPort;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly deps: EventsAuditConsumerDependencies,
    private readonly settings: EventsAuditConsumerSettings,
  ) {
    this.tracer = deps.tracer ?? new NoopTracer();
  }

  onApplicationBootstrap(): void {
    this.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.loop !== undefined || this.abort.signal.aborted) {
      return;
    }
    this.loop = this.run(this.abort.signal);
  }

  async stop(): Promise<void> {
    this.abort.abort();
    if (this.loop !== undefined) {
      await settleWithin(this.loop, EVENTS_AUDIT_DRAIN_TIMEOUT_MS);
    }
    const unfinished = [...this.inFlight.entries()];
    await Promise.all(
      unfinished.map(([receiptHandle, fields]) => this.release(receiptHandle, fields)),
    );
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (this.deps.breaker.isOpen()) {
        await this.deps.breaker.waitUntilClosed(signal);
        continue;
      }
      const messages = await this.receive(signal);
      await Promise.all(messages.map((message) => this.track(message)));
    }
  }

  private async receive(signal: AbortSignal): Promise<readonly Message[]> {
    try {
      const result = await this.deps.receiveClient.send(
        new ReceiveMessageCommand({
          QueueUrl: this.deps.queueUrl,
          MaxNumberOfMessages: EVENTS_AUDIT_RECEIVE_BATCH_SIZE,
          WaitTimeSeconds: this.settings.waitTimeSeconds,
          VisibilityTimeout: this.settings.visibilityTimeoutSeconds,
          MessageAttributeNames: [TRACEPARENT_MESSAGE_ATTRIBUTE],
        }),
        { abortSignal: signal },
      );
      return result.Messages ?? [];
    } catch (error) {
      const failure = this.onQueueFailure(
        'audited event receive failed',
        error,
        signal.aborted,
        {},
      );
      if (failure !== undefined && failure.errorClass !== ErrorClass.Connectivity) {
        await pause(EVENTS_AUDIT_RECEIVE_RETRY_MS, signal);
      }
      return [];
    }
  }

  private async track(message: Message): Promise<void> {
    const receiptHandle = message.ReceiptHandle;
    if (receiptHandle === undefined) {
      return;
    }
    this.inFlight.set(receiptHandle, messageFields(message));
    try {
      await context.with(traceContextOf(message), () =>
        this.tracer.inSpan(SQS_PROCESS_SPAN, spanAttributesOf(message), () =>
          this.handle(message, receiptHandle),
        ),
      );
    } finally {
      this.inFlight.delete(receiptHandle);
    }
  }

  private async handle(message: Message, receiptHandle: string): Promise<void> {
    const body = message.Body;
    const envelope = body === undefined ? undefined : parseAuditedEvent(body);
    if (body === undefined || envelope === undefined) {
      this.deps.logger.error('invalid audited event discarded', {
        ...messageFields(message),
        component: EVENTS_AUDIT_COMPONENT,
      });
      await this.delete(receiptHandle, messageFields(message));
      return;
    }
    await requestContext.run(messageContext(message, envelope), async () => {
      const fields: LogFields = { ...messageFields(message), eventId: envelope.eventId };
      try {
        await this.deps.recordAuditedEvent.execute({ eventId: envelope.eventId, rawBody: body });
      } catch (error) {
        this.onProcessingFailure(error, fields);
        return;
      }
      await this.delete(receiptHandle, fields);
    });
  }

  private onProcessingFailure(error: unknown, fields: LogFields): void {
    const errorClass = classifyError(error);
    if (
      error instanceof TechnicalError &&
      errorClass === ErrorClass.Connectivity &&
      !this.abort.signal.aborted
    ) {
      this.deps.breaker.open(error.probe ?? 'database');
    }
    const logFields = { ...fields, ...technicalFields(error) };
    if (errorClass === ErrorClass.Deterministic) {
      this.deps.logger.error('audited event left for redelivery', logFields);
      return;
    }
    this.deps.logger.warn('audited event left for redelivery', logFields);
  }

  private async delete(receiptHandle: string, fields: LogFields): Promise<void> {
    try {
      await this.deps.client.send(
        new DeleteMessageCommand({ QueueUrl: this.deps.queueUrl, ReceiptHandle: receiptHandle }),
      );
    } catch (error) {
      this.onQueueFailure('audited event delete failed', error, false, fields);
    }
  }

  private async release(receiptHandle: string, fields: LogFields): Promise<void> {
    try {
      await this.deps.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.deps.queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: 0,
        }),
      );
    } catch (error) {
      this.onQueueFailure('audited event release failed', error, false, fields);
    }
  }

  private onQueueFailure(
    message: string,
    error: unknown,
    shuttingDown: boolean,
    fields: LogFields,
  ): TechnicalError | undefined {
    const outcome = sqsErrorClassifier.classify(error, { shuttingDown });
    if (outcome.kind === 'shutdown') {
      return undefined;
    }
    if (outcome.error.errorClass === ErrorClass.Connectivity && !this.abort.signal.aborted) {
      this.deps.breaker.open('queue');
    }
    this.deps.logger.warn(message, {
      ...fields,
      component: EVENTS_AUDIT_COMPONENT,
      errorClass: outcome.error.errorClass,
      reason: outcome.error.reason,
    });
    return outcome.error;
  }
}
