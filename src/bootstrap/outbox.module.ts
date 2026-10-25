import { Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import type { FaultInjectorPort } from '@application/ports/fault-injector.port';
import type { LoggerPort } from '@application/ports/logger.port';
import type { MetricsPort } from '@application/ports/metrics.port';
import { UnitOfWorkPort } from '@application/ports/unit-of-work.port';
import { PublishOutboxBatchUseCase } from '@application/use-cases/publish-outbox-batch.use-case';
import type { AppConfig } from '@infrastructure/config/env.schema';
import { SqsEventPublisher } from '@infrastructure/messaging/sqs-event-publisher';
import type { SqsClients } from '@infrastructure/messaging/sqs.client';
import { MikroOrmUnitOfWork } from '@infrastructure/persistence/mikro-orm-unit-of-work';
import type { OrmInstances } from '@infrastructure/persistence/orm-instances';
import { EnvFaultInjector } from '@infrastructure/system/env-fault-injector';
import { NoopFaultInjector } from '@infrastructure/system/noop-fault-injector';
import { SystemClock } from '@infrastructure/system/system-clock';
import { CircuitBreaker, type BreakerProbes } from '@interfaces/sqs/circuit-breaker';
import {
  OUTBOX_COMPONENT,
  OutboxPublisherWorker,
} from '@interfaces/workers/outbox-publisher.worker';

export interface OutboxModuleOptions {
  readonly config: AppConfig;
  readonly orm: OrmInstances;
  readonly sqs: SqsClients;
  readonly eventsQueueUrl: string;
  readonly probes: BreakerProbes;
  readonly logger: LoggerPort;
  readonly metrics: MetricsPort;
  readonly closeResources: () => Promise<void>;
}

export class OutboxResources implements OnApplicationShutdown {
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
export class OutboxModule {
  static register(options: OutboxModuleOptions): DynamicModule {
    return {
      module: OutboxModule,
      providers: [
        {
          provide: UnitOfWorkPort,
          useFactory: (): UnitOfWorkPort => new MikroOrmUnitOfWork(options.orm, options.config),
        },
        {
          provide: CircuitBreaker,
          useFactory: (): CircuitBreaker =>
            new CircuitBreaker(OUTBOX_COMPONENT, options.probes, options.metrics, options.logger),
        },
        {
          provide: PublishOutboxBatchUseCase,
          inject: [UnitOfWorkPort],
          useFactory: (unitOfWork: UnitOfWorkPort): PublishOutboxBatchUseCase =>
            new PublishOutboxBatchUseCase(
              unitOfWork,
              new SqsEventPublisher(options.sqs.default, options.eventsQueueUrl),
              new SystemClock(),
              faultInjectorFor(options.config),
              options.metrics,
              options.logger,
              {
                instanceId: options.config.INSTANCE_ID,
                leaseMs: options.config.OUTBOX_LEASE_MS,
                batchSize: options.config.OUTBOX_BATCH_SIZE,
              },
            ),
        },
        {
          provide: OutboxPublisherWorker,
          inject: [UnitOfWorkPort, PublishOutboxBatchUseCase, CircuitBreaker],
          useFactory: (
            unitOfWork: UnitOfWorkPort,
            publishBatch: PublishOutboxBatchUseCase,
            breaker: CircuitBreaker,
          ): OutboxPublisherWorker =>
            new OutboxPublisherWorker(
              { unitOfWork, publishBatch, breaker, logger: options.logger },
              { idleMs: options.config.OUTBOX_IDLE_MS },
            ),
        },
        {
          provide: OutboxResources,
          useFactory: (): OutboxResources => new OutboxResources(options.closeResources),
        },
      ],
    };
  }
}
