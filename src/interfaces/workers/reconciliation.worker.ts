import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import { TechnicalError, classifyError } from '@application/errors/error-class';
import type { IdGeneratorPort } from '@application/ports/id-generator.port';
import type { LogFields, LoggerPort } from '@application/ports/logger.port';
import type {
  GlobalReconciliationResult,
  RunGlobalReconciliationUseCase,
} from '@application/use-cases/run-global-reconciliation.use-case';
import { requestContext } from '@infrastructure/observability/request-context';
import { SCHEDULER_COMPONENT } from './pending-reference.worker';

export const RECONCILIATION_DRAIN_TIMEOUT_MS = 10_000;

export interface ReconciliationWorkerDependencies {
  readonly reconcile: Pick<RunGlobalReconciliationUseCase, 'execute'>;
  readonly ids: IdGeneratorPort;
  readonly logger: LoggerPort;
}

export interface ReconciliationWorkerSettings {
  readonly instanceId: string;
  readonly intervalMs: number;
}

const failureFields = (error: unknown): LogFields =>
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

export class ReconciliationWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;

  constructor(
    private readonly deps: ReconciliationWorkerDependencies,
    private readonly settings: ReconciliationWorkerSettings,
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
      await settleWithin(this.loop, RECONCILIATION_DRAIN_TIMEOUT_MS);
    }
  }

  async runOnce(): Promise<GlobalReconciliationResult | undefined> {
    const correlationId = this.deps.ids.next();
    return requestContext.run(
      { correlationId, instanceId: this.settings.instanceId, component: SCHEDULER_COMPONENT },
      () => this.reconcile(correlationId),
    );
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.runOnce();
      await pause(this.settings.intervalMs, signal);
    }
  }

  private async reconcile(correlationId: string): Promise<GlobalReconciliationResult | undefined> {
    try {
      return await this.deps.reconcile.execute({ correlationId });
    } catch (error) {
      this.deps.logger.error('global reconciliation failed', {
        correlationId,
        component: SCHEDULER_COMPONENT,
        ...failureFields(error),
      });
      return undefined;
    }
  }
}
