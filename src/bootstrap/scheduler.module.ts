import type { SQSClient } from '@aws-sdk/client-sqs';
import { Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import type { FaultInjectorPort } from '@application/ports/fault-injector.port';
import type { LoggerPort } from '@application/ports/logger.port';
import type { MetricsPort } from '@application/ports/metrics.port';
import type { TracerPort } from '@application/ports/tracer.port';
import { UnitOfWorkPort } from '@application/ports/unit-of-work.port';
import { AnomalyDetector } from '@application/services/anomaly-detector';
import { OutcomeMapper } from '@application/services/outcome-mapper';
import { FailPendingReferenceUseCase } from '@application/use-cases/fail-pending-reference.use-case';
import { ReconcileWalletUseCase } from '@application/use-cases/reconcile-wallet.use-case';
import { ResolvePendingReferenceUseCase } from '@application/use-cases/resolve-pending-reference.use-case';
import { RunGlobalReconciliationUseCase } from '@application/use-cases/run-global-reconciliation.use-case';
import { TransactionApplier } from '@domain/wagering/transaction-applier';
import type { AppConfig } from '@infrastructure/config/env.schema';
import { contextEnricher } from '@infrastructure/observability/context-enricher';
import { MikroOrmUnitOfWork } from '@infrastructure/persistence/mikro-orm-unit-of-work';
import type { OrmInstances } from '@infrastructure/persistence/orm-instances';
import { createRepositories } from '@infrastructure/persistence/repositories.factory';
import { EnvFaultInjector } from '@infrastructure/system/env-fault-injector';
import { NoopFaultInjector } from '@infrastructure/system/noop-fault-injector';
import { NoopTracer } from '@infrastructure/system/noop-tracer';
import { SystemClock } from '@infrastructure/system/system-clock';
import { Uuidv7IdGenerator } from '@infrastructure/system/uuidv7-id-generator';
import { CircuitBreaker, type BreakerProbes } from '@interfaces/sqs/circuit-breaker';
import { MetricsSamplerWorker } from '@interfaces/workers/metrics-sampler.worker';
import {
  PendingReferenceWorker,
  SCHEDULER_COMPONENT,
} from '@interfaces/workers/pending-reference.worker';
import { ReconciliationWorker } from '@interfaces/workers/reconciliation.worker';

export interface SchedulerModuleOptions {
  readonly config: AppConfig;
  readonly orm: OrmInstances;
  readonly probes: BreakerProbes;
  readonly sqs: SQSClient;
  readonly dlqUrl: string;
  readonly logger: LoggerPort;
  readonly metrics: MetricsPort;
  readonly tracer?: TracerPort;
  readonly closeResources: () => Promise<void>;
}

export class SchedulerResources implements OnApplicationShutdown {
  constructor(private readonly closeResources: () => Promise<void>) {}

  async onApplicationShutdown(): Promise<void> {
    await this.closeResources();
  }
}

const faultInjectorFor = (config: AppConfig): FaultInjectorPort =>
  config.ENABLE_FAULT_INJECTION
    ? new EnvFaultInjector({
        ENABLE_FAULT_INJECTION: 'true',
        FAULT_POINTS: config.FAULT_POINTS.join(','),
      })
    : new NoopFaultInjector();

@Module({})
export class SchedulerModule {
  static register(options: SchedulerModuleOptions): DynamicModule {
    const { config, logger, metrics } = options;
    const clock = new SystemClock();
    const ids = new Uuidv7IdGenerator();
    const tracer = options.tracer ?? new NoopTracer();
    const outcomeMapper = new OutcomeMapper();
    return {
      module: SchedulerModule,
      providers: [
        {
          provide: UnitOfWorkPort,
          useFactory: (): UnitOfWorkPort =>
            new MikroOrmUnitOfWork(options.orm, config, createRepositories, tracer),
        },
        {
          provide: CircuitBreaker,
          useFactory: (): CircuitBreaker =>
            new CircuitBreaker(SCHEDULER_COMPONENT, options.probes, metrics, logger),
        },
        {
          provide: ResolvePendingReferenceUseCase,
          inject: [UnitOfWorkPort],
          useFactory: (uow: UnitOfWorkPort): ResolvePendingReferenceUseCase =>
            new ResolvePendingReferenceUseCase(
              {
                uow,
                clock,
                ids,
                faults: faultInjectorFor(config),
                logger,
                metrics,
                tracer,
                enrich: contextEnricher,
                applier: TransactionApplier.create(),
                outcomeMapper,
                anomalyDetector: new AnomalyDetector(),
              },
              { instanceId: config.INSTANCE_ID, pendingLeaseMs: config.PENDING_LEASE_MS },
            ),
        },
        {
          provide: FailPendingReferenceUseCase,
          inject: [UnitOfWorkPort],
          useFactory: (uow: UnitOfWorkPort): FailPendingReferenceUseCase =>
            new FailPendingReferenceUseCase(
              { uow, clock, ids, logger, metrics, tracer, enrich: contextEnricher, outcomeMapper },
              { instanceId: config.INSTANCE_ID },
            ),
        },
        {
          provide: PendingReferenceWorker,
          inject: [
            UnitOfWorkPort,
            CircuitBreaker,
            ResolvePendingReferenceUseCase,
            FailPendingReferenceUseCase,
          ],
          useFactory: (
            uow: UnitOfWorkPort,
            breaker: CircuitBreaker,
            resolve: ResolvePendingReferenceUseCase,
            fail: FailPendingReferenceUseCase,
          ): PendingReferenceWorker =>
            new PendingReferenceWorker(
              { uow, clock, resolve, fail, breaker, metrics, logger },
              {
                instanceId: config.INSTANCE_ID,
                leaseMs: config.PENDING_LEASE_MS,
                batchSize: config.PENDING_BATCH_SIZE,
                maxDeterministicErrors: config.PENDING_MAX_DETERMINISTIC_ERRORS,
              },
            ),
        },
        {
          provide: MetricsSamplerWorker,
          inject: [UnitOfWorkPort],
          useFactory: (uow: UnitOfWorkPort): MetricsSamplerWorker =>
            new MetricsSamplerWorker(
              { uow, clock, sqs: options.sqs, metrics, logger },
              { intervalMs: config.METRICS_SAMPLE_INTERVAL_MS, dlqUrl: options.dlqUrl },
            ),
        },
        {
          provide: RunGlobalReconciliationUseCase,
          inject: [UnitOfWorkPort],
          useFactory: (uow: UnitOfWorkPort): RunGlobalReconciliationUseCase =>
            new RunGlobalReconciliationUseCase(
              uow,
              new ReconcileWalletUseCase(uow, ids, clock, metrics, logger),
              ids,
              clock,
              metrics,
              logger,
              { instanceId: config.INSTANCE_ID, intervalMs: config.RECONCILIATION_INTERVAL_MS },
            ),
        },
        {
          provide: ReconciliationWorker,
          inject: [RunGlobalReconciliationUseCase],
          useFactory: (reconcile: RunGlobalReconciliationUseCase): ReconciliationWorker =>
            new ReconciliationWorker(
              { reconcile, ids, logger },
              { instanceId: config.INSTANCE_ID, intervalMs: config.RECONCILIATION_INTERVAL_MS },
            ),
        },
        {
          provide: SchedulerResources,
          useFactory: (): SchedulerResources => new SchedulerResources(options.closeResources),
        },
      ],
    };
  }
}
