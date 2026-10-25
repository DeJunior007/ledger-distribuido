import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import { TechnicalError, classifyError } from '@application/errors/error-class';
import type { ClockPort } from '@application/ports/clock.port';
import type { LogFields, LoggerPort } from '@application/ports/logger.port';
import type { MetricsPort } from '@application/ports/metrics.port';
import type { UnitOfWorkPort } from '@application/ports/unit-of-work.port';
import { QueueNames } from '@infrastructure/messaging/queue-names';
import { SCHEDULER_COMPONENT } from './pending-reference.worker';

export const DLQ_DEPTH_ATTRIBUTE = 'ApproximateNumberOfMessages';

export interface MetricsSamplerWorkerDependencies {
  readonly uow: Pick<UnitOfWorkPort, 'run'>;
  readonly clock: ClockPort;
  readonly sqs: Pick<SQSClient, 'send'>;
  readonly metrics: MetricsPort;
  readonly logger: LoggerPort;
}

export interface MetricsSamplerWorkerSettings {
  readonly intervalMs: number;
  readonly dlqUrl: string;
}

class InvalidQueueDepthError extends Error {
  constructor() {
    super('queue depth attribute is missing or not a number');
    this.name = 'InvalidQueueDepthError';
  }
}

const failureFields = (error: unknown): LogFields =>
  error instanceof TechnicalError
    ? { component: SCHEDULER_COMPONENT, errorClass: error.errorClass, reason: error.reason }
    : { component: SCHEDULER_COMPONENT, errorClass: classifyError(error) };

const parseDepth = (value: string | undefined): number => {
  const depth = Number(value);
  if (value === undefined || value === '' || !Number.isSafeInteger(depth) || depth < 0) {
    throw new InvalidQueueDepthError();
  }
  return depth;
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

export class MetricsSamplerWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;

  constructor(
    private readonly deps: MetricsSamplerWorkerDependencies,
    private readonly settings: MetricsSamplerWorkerSettings,
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
    await this.loop;
  }

  async sample(): Promise<void> {
    await this.sampleDatabase();
    await this.sampleDlq();
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.sample();
      await pause(this.settings.intervalMs, signal);
    }
  }

  private async sampleDatabase(): Promise<void> {
    try {
      const sampled = await this.deps.uow.run('short', async (repos) => ({
        outbox: await repos.outbox.gauges(this.deps.clock.now()),
        pendingOpen: await repos.pendingReferences.openCount(),
      }));
      this.deps.metrics.setOutboxGauges(sampled.outbox);
      this.deps.metrics.setPendingOpen(sampled.pendingOpen);
    } catch (error) {
      this.deps.logger.warn('database gauge sampling failed', failureFields(error));
    }
  }

  private async sampleDlq(): Promise<void> {
    try {
      const result = await this.deps.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.settings.dlqUrl,
          AttributeNames: [DLQ_DEPTH_ATTRIBUTE],
        }),
      );
      const depth = parseDepth(result.Attributes?.[DLQ_DEPTH_ATTRIBUTE]);
      this.deps.metrics.setDlqDepth(QueueNames.WagerTransactionsDlq, depth);
    } catch (error) {
      this.deps.logger.warn('dlq depth sampling failed', failureFields(error));
    }
  }
}
