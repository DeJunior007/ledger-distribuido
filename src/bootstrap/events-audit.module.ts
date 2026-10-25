import { Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import type { LoggerPort } from '@application/ports/logger.port';
import type { MetricsPort } from '@application/ports/metrics.port';
import { RecordAuditedEventUseCase } from '@application/use-cases/record-audited-event.use-case';
import type { AppConfig } from '@infrastructure/config/env.schema';
import type { SqsClients } from '@infrastructure/messaging/sqs.client';
import { MikroOrmUnitOfWork } from '@infrastructure/persistence/mikro-orm-unit-of-work';
import type { OrmInstances } from '@infrastructure/persistence/orm-instances';
import { Sha256Hasher } from '@infrastructure/system/sha256-hasher';
import { SystemClock } from '@infrastructure/system/system-clock';
import { CircuitBreaker, type BreakerProbes } from '@interfaces/sqs/circuit-breaker';
import { EventsAuditConsumer } from '@interfaces/workers/events-audit.consumer';

export interface EventsAuditModuleOptions {
  readonly config: AppConfig;
  readonly orm: OrmInstances;
  readonly sqs: SqsClients;
  readonly queueUrl: string;
  readonly probes: BreakerProbes;
  readonly logger: LoggerPort;
  readonly metrics: MetricsPort;
  readonly closeResources: () => Promise<void>;
}

export class EventsAuditResources implements OnApplicationShutdown {
  constructor(private readonly closeResources: () => Promise<void>) {}

  async onApplicationShutdown(): Promise<void> {
    await this.closeResources();
  }
}

@Module({})
export class EventsAuditModule {
  static register(options: EventsAuditModuleOptions): DynamicModule {
    return {
      module: EventsAuditModule,
      providers: [
        {
          provide: CircuitBreaker,
          useFactory: (): CircuitBreaker =>
            new CircuitBreaker('events-audit', options.probes, options.metrics, options.logger),
        },
        {
          provide: RecordAuditedEventUseCase,
          useFactory: (): RecordAuditedEventUseCase =>
            new RecordAuditedEventUseCase(
              new MikroOrmUnitOfWork(options.orm, options.config),
              new Sha256Hasher(),
              new SystemClock(),
              options.metrics,
              options.logger,
            ),
        },
        {
          provide: EventsAuditConsumer,
          inject: [CircuitBreaker, RecordAuditedEventUseCase],
          useFactory: (
            breaker: CircuitBreaker,
            recordAuditedEvent: RecordAuditedEventUseCase,
          ): EventsAuditConsumer =>
            new EventsAuditConsumer(
              {
                receiveClient: options.sqs.receive,
                client: options.sqs.default,
                queueUrl: options.queueUrl,
                recordAuditedEvent,
                breaker,
                logger: options.logger,
              },
              {
                waitTimeSeconds: options.config.SQS_RECEIVE_WAIT_SECONDS,
                visibilityTimeoutSeconds: options.config.CONSUMER_VISIBILITY_TIMEOUT_SECONDS,
              },
            ),
        },
        {
          provide: EventsAuditResources,
          useFactory: (): EventsAuditResources => new EventsAuditResources(options.closeResources),
        },
      ],
    };
  }
}
