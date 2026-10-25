import {
  ChangeMessageVisibilityBatchCommand,
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import type { Message, MessageSystemAttributeName, SQSClient } from '@aws-sdk/client-sqs';
import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';
import { ErrorClass } from '@application/errors/error-class';
import type { TechnicalError } from '@application/errors/error-class';
import type { FaultInjectorPort } from '@application/ports/fault-injector.port';
import type { LogFields, LoggerPort } from '@application/ports/logger.port';
import { sqsErrorClassifier } from '@infrastructure/messaging/sqs-error-classifier';
import type { CircuitBreaker } from './circuit-breaker';
import type { DlqMover } from './dlq-mover';
import { readEnvelopeMessageId } from './message-envelope.schema';
import type { MessageAction, MessageProcessor } from './message-processor';

export const CONSUMER_COMPONENT = 'consumer';
export const CONSUMER_RECEIVE_BATCH_SIZE = 10;
export const CONSUMER_DRAIN_TIMEOUT_MS = 10_000;
export const CONSUMER_RECEIVE_RETRY_MS = 1_000;
export const CONSUMER_SYSTEM_ATTRIBUTES: readonly MessageSystemAttributeName[] = [
  'ApproximateReceiveCount',
  'MessageGroupId',
];

export interface WagerTransactionConsumerDependencies {
  readonly receiveClient: SQSClient;
  readonly client: SQSClient;
  readonly queueUrl: string;
  readonly processor: Pick<MessageProcessor, 'process'>;
  readonly mover: Pick<DlqMover, 'move'>;
  readonly breaker: Pick<CircuitBreaker, 'isOpen' | 'open' | 'waitUntilClosed'>;
  readonly faults: FaultInjectorPort;
  readonly logger: LoggerPort;
}

export interface WagerTransactionConsumerSettings {
  readonly waitTimeSeconds: number;
  readonly visibilityTimeoutSeconds: number;
  readonly heartbeatMs: number;
}

export interface RedrivePolicyExpectation {
  readonly queueUrl: string;
  readonly dlqUrl: string;
  readonly maxReceiveCount: number;
}

export class RedrivePolicyMismatchError extends Error {
  constructor(detail: string) {
    super(
      `Redrive policy of the wager transactions queue does not match the configuration: ${detail}`,
    );
    this.name = 'RedrivePolicyMismatchError';
  }
}

type HeldMessage = Message & { readonly ReceiptHandle: string };

type Settlement =
  { readonly kind: 'concluded' } | { readonly kind: 'held'; readonly backoffSeconds: number };

const CONCLUDED: Settlement = { kind: 'concluded' };

const redrivePolicySchema = z.object({
  maxReceiveCount: z.union([z.number(), z.string()]),
  deadLetterTargetArn: z.string(),
});

const isHeld = (message: Message): message is HeldMessage => message.ReceiptHandle !== undefined;

const messageFields = (message: Message): LogFields => {
  const messageId = readEnvelopeMessageId(message.Body) ?? message.MessageId;
  return messageId === undefined
    ? { component: CONSUMER_COMPONENT }
    : { messageId, component: CONSUMER_COMPONENT };
};

const groupKeyOf = (message: Message): string => message.Attributes?.MessageGroupId ?? '';

export const groupByMessageGroup = (
  messages: readonly HeldMessage[],
): readonly (readonly HeldMessage[])[] => {
  const groups = new Map<string, HeldMessage[]>();
  for (const message of messages) {
    const key = groupKeyOf(message);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [message]);
    } else {
      group.push(message);
    }
  }
  return [...groups.values()];
};

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

const queueArnOf = async (client: SQSClient, queueUrl: string): Promise<string | undefined> => {
  const result = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
  );
  return result.Attributes?.QueueArn;
};

export const verifyRedrivePolicy = async (
  client: SQSClient,
  expectation: RedrivePolicyExpectation,
): Promise<void> => {
  const result = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: expectation.queueUrl,
      AttributeNames: ['RedrivePolicy'],
    }),
  );
  const raw = result.Attributes?.RedrivePolicy;
  if (raw === undefined) {
    throw new RedrivePolicyMismatchError('the queue has no redrive policy');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RedrivePolicyMismatchError('the redrive policy is not valid JSON');
  }
  const policy = redrivePolicySchema.safeParse(parsed);
  if (!policy.success) {
    throw new RedrivePolicyMismatchError('the redrive policy has an unexpected shape');
  }
  const maxReceiveCount = Number(policy.data.maxReceiveCount);
  if (maxReceiveCount !== expectation.maxReceiveCount) {
    throw new RedrivePolicyMismatchError(
      `maxReceiveCount is ${String(maxReceiveCount)}, expected ${String(expectation.maxReceiveCount)}`,
    );
  }
  const dlqArn = await queueArnOf(client, expectation.dlqUrl);
  if (dlqArn === undefined || policy.data.deadLetterTargetArn !== dlqArn) {
    throw new RedrivePolicyMismatchError(
      `deadLetterTargetArn is ${policy.data.deadLetterTargetArn}, expected ${dlqArn ?? 'the dead letter queue'}`,
    );
  }
};

export class WagerTransactionConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly abort = new AbortController();
  private readonly inHand = new Map<string, HeldMessage>();
  private loop: Promise<void> | undefined;

  constructor(
    private readonly deps: WagerTransactionConsumerDependencies,
    private readonly settings: WagerTransactionConsumerSettings,
  ) {}

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
      await settleWithin(this.loop, CONSUMER_DRAIN_TIMEOUT_MS);
    }
    const unfinished = [...this.inHand.values()];
    await Promise.all(unfinished.map((message) => this.changeVisibility(message, 0)));
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (this.deps.breaker.isOpen()) {
        await this.deps.breaker.waitUntilClosed(signal);
        continue;
      }
      const messages = await this.receive(signal);
      await Promise.all(groupByMessageGroup(messages).map((group) => this.processGroup(group)));
    }
  }

  private async receive(signal: AbortSignal): Promise<readonly HeldMessage[]> {
    try {
      const result = await this.deps.receiveClient.send(
        new ReceiveMessageCommand({
          QueueUrl: this.deps.queueUrl,
          MaxNumberOfMessages: CONSUMER_RECEIVE_BATCH_SIZE,
          WaitTimeSeconds: this.settings.waitTimeSeconds,
          VisibilityTimeout: this.settings.visibilityTimeoutSeconds,
          MessageSystemAttributeNames: [...CONSUMER_SYSTEM_ATTRIBUTES],
          MessageAttributeNames: ['All'],
        }),
        { abortSignal: signal },
      );
      const messages = (result.Messages ?? []).filter(isHeld);
      for (const message of messages) {
        this.inHand.set(message.ReceiptHandle, message);
      }
      return messages;
    } catch (error) {
      const failure = this.onQueueFailure('message receive failed', error, signal.aborted, {
        component: CONSUMER_COMPONENT,
      });
      if (failure !== undefined && failure.errorClass !== ErrorClass.Connectivity) {
        await pause(CONSUMER_RECEIVE_RETRY_MS, signal);
      }
      return [];
    }
  }

  private async processGroup(group: readonly HeldMessage[]): Promise<void> {
    const heartbeat = setInterval(() => {
      void this.extendVisibility(group);
    }, this.settings.heartbeatMs);
    try {
      for (const [index, message] of group.entries()) {
        if (this.abort.signal.aborted) {
          return;
        }
        const settlement = await this.settle(message);
        if (settlement.kind === 'held') {
          await this.holdBack(group.slice(index + 1), settlement.backoffSeconds);
          return;
        }
      }
    } catch (error) {
      this.deps.logger.error('message group processing failed', {
        component: CONSUMER_COMPONENT,
        ...(error instanceof Error ? { reason: error.name } : {}),
      });
      for (const message of group) {
        this.inHand.delete(message.ReceiptHandle);
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async settle(message: HeldMessage): Promise<Settlement> {
    const action = await this.deps.processor.process(message);
    try {
      return await this.execute(message, action);
    } finally {
      this.inHand.delete(message.ReceiptHandle);
    }
  }

  private async execute(message: HeldMessage, action: MessageAction): Promise<Settlement> {
    switch (action.kind) {
      case 'ack':
        this.deps.faults.hit('consumer.after_commit_before_ack');
        await this.delete(message);
        return CONCLUDED;
      case 'delete':
        await this.delete(message);
        return CONCLUDED;
      case 'dlq':
        return this.moveToDlq(message, action);
      case 'backoff':
        await this.changeVisibility(message, action.backoffSeconds);
        return { kind: 'held', backoffSeconds: action.backoffSeconds };
    }
  }

  private async moveToDlq(
    message: HeldMessage,
    action: Extract<MessageAction, { kind: 'dlq' }>,
  ): Promise<Settlement> {
    const result = await this.deps.mover.move({
      message,
      reason: action.reason,
      failureCode: action.failureCode,
      backoffSeconds: action.backoffSeconds,
    });
    if (result.kind === 'moved') {
      return CONCLUDED;
    }
    this.openBreakerOnConnectivity(result.error);
    return { kind: 'held', backoffSeconds: action.backoffSeconds };
  }

  private async holdBack(rest: readonly HeldMessage[], backoffSeconds: number): Promise<void> {
    await Promise.all(rest.map((message) => this.changeVisibility(message, backoffSeconds)));
  }

  private async extendVisibility(group: readonly HeldMessage[]): Promise<void> {
    const held = group.filter((message) => this.inHand.has(message.ReceiptHandle));
    if (held.length === 0) {
      return;
    }
    try {
      const result = await this.deps.client.send(
        new ChangeMessageVisibilityBatchCommand({
          QueueUrl: this.deps.queueUrl,
          Entries: held.map((message, index) => ({
            Id: String(index),
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: this.settings.visibilityTimeoutSeconds,
          })),
        }),
      );
      for (const entry of result.Failed ?? []) {
        const error = sqsErrorClassifier.classifyBatchEntry(entry);
        this.deps.logger.warn('visibility heartbeat entry failed', {
          component: CONSUMER_COMPONENT,
          errorClass: error.errorClass,
          reason: error.reason,
        });
      }
    } catch (error) {
      this.onQueueFailure('visibility heartbeat failed', error, false, {
        component: CONSUMER_COMPONENT,
      });
    }
  }

  private async delete(message: HeldMessage): Promise<void> {
    try {
      await this.deps.client.send(
        new DeleteMessageCommand({
          QueueUrl: this.deps.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    } catch (error) {
      this.onQueueFailure('message delete failed', error, false, messageFields(message));
    }
  }

  private async changeVisibility(message: HeldMessage, visibilityTimeout: number): Promise<void> {
    if (!this.inHand.delete(message.ReceiptHandle)) {
      return;
    }
    try {
      await this.deps.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.deps.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: visibilityTimeout,
        }),
      );
    } catch (error) {
      this.onQueueFailure('message visibility change failed', error, false, messageFields(message));
    }
  }

  private openBreakerOnConnectivity(error: TechnicalError): void {
    if (error.errorClass === ErrorClass.Connectivity && !this.abort.signal.aborted) {
      this.deps.breaker.open(error.probe ?? 'queue');
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
    this.openBreakerOnConnectivity(outcome.error);
    this.deps.logger.warn(message, {
      ...fields,
      errorClass: outcome.error.errorClass,
      reason: outcome.error.reason,
    });
    return outcome.error;
  }
}
