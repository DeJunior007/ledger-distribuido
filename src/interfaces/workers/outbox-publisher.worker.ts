import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import { ErrorClass, TechnicalError, classifyError } from '@application/errors/error-class';
import type { LogFields, LoggerPort } from '@application/ports/logger.port';
import type { UnitOfWorkPort } from '@application/ports/unit-of-work.port';
import { PublishOutboxBatchUseCase } from '@application/use-cases/publish-outbox-batch.use-case';
import { CircuitBreaker } from '@interfaces/sqs/circuit-breaker';
import type { BreakerProbe } from '@interfaces/sqs/circuit-breaker';

export const OUTBOX_COMPONENT = 'outbox';
export const OUTBOX_IDLE_JITTER_RATIO = 0.2;

export interface OutboxPublisherWorkerDependencies {
  readonly unitOfWork: Pick<UnitOfWorkPort, 'run'>;
  readonly publishBatch: Pick<PublishOutboxBatchUseCase, 'execute'>;
  readonly breaker: Pick<CircuitBreaker, 'isOpen' | 'open' | 'waitUntilClosed'>;
  readonly logger: LoggerPort;
}

export interface OutboxPublisherWorkerSettings {
  readonly idleMs: number;
  readonly random?: () => number;
}

type CycleOutcome = { readonly kind: 'again' } | { readonly kind: 'sleep'; readonly ms: number };

const AGAIN: CycleOutcome = { kind: 'again' };

export const jitteredIdleMs = (idleMs: number, random: () => number): number =>
  idleMs * (1 + (random() * 2 - 1) * OUTBOX_IDLE_JITTER_RATIO);

const technicalFields = (error: unknown): LogFields =>
  error instanceof TechnicalError
    ? { component: OUTBOX_COMPONENT, errorClass: error.errorClass, reason: error.reason }
    : { component: OUTBOX_COMPONENT, errorClass: classifyError(error) };

const connectivityProbe = (error: unknown): BreakerProbe | undefined =>
  error instanceof TechnicalError && classifyError(error) === ErrorClass.Connectivity
    ? (error.probe ?? 'database')
    : undefined;

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

export class OutboxPublisherWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly abort = new AbortController();
  private readonly random: () => number;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly deps: OutboxPublisherWorkerDependencies,
    private readonly settings: OutboxPublisherWorkerSettings,
  ) {
    this.random = settings.random ?? Math.random;
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
    await this.loop;
  }

  private async run(signal: AbortSignal): Promise<void> {
    await this.requeueParkedOnBoot(signal);
    while (!signal.aborted) {
      if (this.deps.breaker.isOpen()) {
        await this.deps.breaker.waitUntilClosed(signal);
        continue;
      }
      const outcome = await this.cycle();
      if (outcome.kind === 'sleep') {
        await pause(outcome.ms, signal);
      }
    }
  }

  private async requeueParkedOnBoot(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (this.deps.breaker.isOpen()) {
        await this.deps.breaker.waitUntilClosed(signal);
        continue;
      }
      try {
        const requeued = await this.deps.unitOfWork.run('short', (repos) =>
          repos.outbox.requeueParked(undefined),
        );
        this.deps.logger.info(`requeued ${String(requeued)} parked outbox events`, {
          component: OUTBOX_COMPONENT,
        });
        return;
      } catch (error) {
        const outcome = this.onFailure('outbox requeue of parked events failed', error);
        if (outcome.kind === 'sleep') {
          await pause(outcome.ms, signal);
        }
      }
    }
  }

  private async cycle(): Promise<CycleOutcome> {
    try {
      const result = await this.deps.publishBatch.execute();
      if (result.connectivityFailure) {
        this.deps.breaker.open('queue');
        return AGAIN;
      }
      return result.full
        ? AGAIN
        : { kind: 'sleep', ms: jitteredIdleMs(this.settings.idleMs, this.random) };
    } catch (error) {
      return this.onFailure('outbox batch failed', error);
    }
  }

  private onFailure(message: string, error: unknown): CycleOutcome {
    const probe = connectivityProbe(error);
    if (probe !== undefined) {
      this.deps.logger.warn(message, technicalFields(error));
      this.deps.breaker.open(probe);
      return AGAIN;
    }
    this.deps.logger.error(message, technicalFields(error));
    return { kind: 'sleep', ms: this.settings.idleMs };
  }
}
