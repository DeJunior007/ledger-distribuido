import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import { ErrorClass, TechnicalError, classifyError } from '@application/errors/error-class';
import type { ClockPort } from '@application/ports/clock.port';
import type { LogFields, LoggerPort } from '@application/ports/logger.port';
import type { MetricsPort } from '@application/ports/metrics.port';
import type { PendingReferenceRetry } from '@application/ports/repositories/pending-reference-repository.port';
import type { UnitOfWorkPort } from '@application/ports/unit-of-work.port';
import {
  deterministicRetryDelayMs,
  type FailPendingReferenceUseCase,
} from '@application/use-cases/fail-pending-reference.use-case';
import {
  MAX_PENDING_RETRY_DELAY_MS,
  type ResolvePendingReferenceUseCase,
} from '@application/use-cases/resolve-pending-reference.use-case';
import { requestContext } from '@infrastructure/observability/request-context';
import type { CircuitBreaker } from '@interfaces/sqs/circuit-breaker';

export const SCHEDULER_COMPONENT = 'scheduler';
export const PENDING_REFERENCE_CYCLE_MS = 1_000;
export const PENDING_REFERENCE_DRAIN_TIMEOUT_MS = 10_000;

const SECOND_MS = 1_000;

export const technicalRetryDelayMs = (attempts: number): number =>
  Math.min(2 ** attempts * SECOND_MS, MAX_PENDING_RETRY_DELAY_MS);

export interface PendingReferenceWorkerDependencies {
  readonly uow: UnitOfWorkPort;
  readonly clock: ClockPort;
  readonly resolve: Pick<ResolvePendingReferenceUseCase, 'execute'>;
  readonly fail: Pick<FailPendingReferenceUseCase, 'execute'>;
  readonly breaker: Pick<CircuitBreaker, 'isOpen' | 'open' | 'waitUntilClosed'>;
  readonly metrics: MetricsPort;
  readonly logger: LoggerPort;
}

export interface PendingReferenceWorkerSettings {
  readonly instanceId: string;
  readonly leaseMs: number;
  readonly batchSize: number;
  readonly maxDeterministicErrors: number;
}

interface NextAttempt {
  readonly delayMs: number;
  readonly consecutiveErrors: number;
}

const failureFields = (error: unknown): LogFields =>
  error instanceof TechnicalError
    ? { errorClass: error.errorClass, reason: error.reason }
    : { errorClass: classifyError(error) };

const lockConflictTypeOf = (error: unknown): 'lock_timeout' | 'version_mismatch' | undefined =>
  error instanceof TechnicalError &&
  (error.reason === 'lock_timeout' || error.reason === 'version_mismatch')
    ? error.reason
    : undefined;

const isTechnicalRetry = (errorClass: ErrorClass): boolean =>
  errorClass === ErrorClass.Transient ||
  errorClass === ErrorClass.Race ||
  errorClass === ErrorClass.Connectivity;

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

export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;

  constructor(
    private readonly deps: PendingReferenceWorkerDependencies,
    private readonly settings: PendingReferenceWorkerSettings,
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
      await settleWithin(this.loop, PENDING_REFERENCE_DRAIN_TIMEOUT_MS);
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (this.deps.breaker.isOpen()) {
        await this.deps.breaker.waitUntilClosed(signal);
        continue;
      }
      const claimed = await this.claim();
      await this.processInSeries(claimed, signal);
      if (claimed.length < this.settings.batchSize) {
        await pause(PENDING_REFERENCE_CYCLE_MS, signal);
      }
    }
  }

  private async claim(): Promise<readonly PendingReferenceRetry[]> {
    try {
      return await this.deps.uow.run('short', (repos) =>
        repos.pendingReferences.claimDue({
          instanceId: this.settings.instanceId,
          leaseMs: this.settings.leaseMs,
          limit: this.settings.batchSize,
        }),
      );
    } catch (error) {
      this.onTechnicalFailure('pending reference claim failed', error, {});
      return [];
    }
  }

  private async processInSeries(
    claimed: readonly PendingReferenceRetry[],
    signal: AbortSignal,
  ): Promise<void> {
    for (const retry of claimed) {
      if (signal.aborted || this.deps.breaker.isOpen()) {
        return;
      }
      await requestContext.run(
        {
          transactionId: retry.transactionId,
          instanceId: this.settings.instanceId,
          component: SCHEDULER_COMPONENT,
        },
        () => this.process(retry),
      );
    }
  }

  private async process(retry: PendingReferenceRetry): Promise<void> {
    try {
      await this.deps.resolve.execute(retry);
    } catch (error) {
      await this.handleFailure(retry, error);
    }
  }

  private async handleFailure(retry: PendingReferenceRetry, error: unknown): Promise<void> {
    const errorClass = classifyError(error);
    const fields: LogFields = {
      transactionId: retry.transactionId,
      component: SCHEDULER_COMPONENT,
    };
    if (isTechnicalRetry(errorClass)) {
      this.onTechnicalFailure('pending reference resolution deferred', error, fields);
      await this.reschedule(retry, {
        delayMs: technicalRetryDelayMs(retry.attempts),
        consecutiveErrors: retry.consecutiveErrors,
      });
      return;
    }
    this.deps.logger.error('pending reference resolution failed', {
      ...fields,
      ...failureFields(error),
    });
    const consecutiveErrors = retry.consecutiveErrors + 1;
    const expired = this.deps.clock.now().getTime() >= retry.deadlineAt.getTime();
    if (consecutiveErrors >= this.settings.maxDeterministicErrors || expired) {
      await this.failPending(retry, fields);
      return;
    }
    await this.reschedule(retry, {
      delayMs: deterministicRetryDelayMs(consecutiveErrors),
      consecutiveErrors,
    });
  }

  private async failPending(retry: PendingReferenceRetry, fields: LogFields): Promise<void> {
    try {
      await this.deps.fail.execute(retry);
    } catch (error) {
      this.onTechnicalFailure('pending reference failure path interrupted', error, fields);
    }
  }

  private async reschedule(retry: PendingReferenceRetry, next: NextAttempt): Promise<void> {
    try {
      await this.deps.uow.run('short', (repos) =>
        repos.pendingReferences.scheduleNext({
          transactionId: retry.transactionId,
          instanceId: this.settings.instanceId,
          nextAttemptAt: new Date(this.deps.clock.now().getTime() + next.delayMs),
          attempts: retry.attempts,
          consecutiveErrors: next.consecutiveErrors,
        }),
      );
    } catch (error) {
      this.onTechnicalFailure('pending reference reschedule failed', error, {
        transactionId: retry.transactionId,
        component: SCHEDULER_COMPONENT,
      });
    }
  }

  private onTechnicalFailure(message: string, error: unknown, fields: LogFields): void {
    const errorClass = classifyError(error);
    const lockConflict = lockConflictTypeOf(error);
    if (lockConflict !== undefined) {
      this.deps.metrics.lockConflict(lockConflict);
    }
    if (errorClass === ErrorClass.Connectivity && !this.abort.signal.aborted) {
      this.deps.breaker.open('database');
    }
    this.deps.logger.warn(message, {
      component: SCHEDULER_COMPONENT,
      ...fields,
      ...failureFields(error),
    });
  }
}
