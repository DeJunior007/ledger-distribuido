import { Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { TransactionApplier } from '@domain/wagering/transaction-applier';
import type { FaultInjectorPort } from '@application/ports/fault-injector.port';
import type { LoggerPort } from '@application/ports/logger.port';
import type { MetricsPort } from '@application/ports/metrics.port';
import type { TracerPort } from '@application/ports/tracer.port';
import { AnomalyDetector } from '@application/services/anomaly-detector';
import { OutcomeMapper } from '@application/services/outcome-mapper';
import { MarkTransactionFailedUseCase } from '@application/use-cases/mark-transaction-failed.use-case';
import { SubmitWagerTransactionUseCase } from '@application/use-cases/submit-wager-transaction.use-case';
import type { AppConfig } from '@infrastructure/config/env.schema';
import type { SqsClients } from '@infrastructure/messaging/sqs.client';
import { contextEnricher } from '@infrastructure/observability/context-enricher';
import { MikroOrmUnitOfWork } from '@infrastructure/persistence/mikro-orm-unit-of-work';
import type { OrmInstances } from '@infrastructure/persistence/orm-instances';
import { createRepositories } from '@infrastructure/persistence/repositories.factory';
import { EnvFaultInjector } from '@infrastructure/system/env-fault-injector';
import { NoopFaultInjector } from '@infrastructure/system/noop-fault-injector';
import { NoopTracer } from '@infrastructure/system/noop-tracer';
import { Sha256Hasher } from '@infrastructure/system/sha256-hasher';
import { SystemClock } from '@infrastructure/system/system-clock';
import { Uuidv7IdGenerator } from '@infrastructure/system/uuidv7-id-generator';
import { CircuitBreaker, type BreakerProbes } from '@interfaces/sqs/circuit-breaker';
import { DlqMover } from '@interfaces/sqs/dlq-mover';
import { MessageProcessor } from '@interfaces/sqs/message-processor';
import { WagerTransactionConsumer } from '@interfaces/sqs/wager-transaction.consumer';

export interface ConsumerModuleOptions {
  readonly config: AppConfig;
  readonly orm: OrmInstances;
  readonly sqs: SqsClients;
  readonly queueUrl: string;
  readonly dlqUrl: string;
  readonly probes: BreakerProbes;
  readonly logger: LoggerPort;
  readonly metrics: MetricsPort;
  readonly tracer?: TracerPort;
  readonly closeResources: () => Promise<void>;
}

export class ConsumerResources implements OnApplicationShutdown {
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

const buildProcessor = (
  options: ConsumerModuleOptions,
  breaker: CircuitBreaker,
  faults: FaultInjectorPort,
  tracer: TracerPort,
): MessageProcessor => {
  const { config, logger, metrics } = options;
  const uow = new MikroOrmUnitOfWork(options.orm, config, createRepositories, tracer);
  const clock = new SystemClock();
  const ids = new Uuidv7IdGenerator();
  const hasher = new Sha256Hasher();
  const outcomeMapper = new OutcomeMapper();
  const submit = new SubmitWagerTransactionUseCase(
    {
      uow,
      clock,
      ids,
      hasher,
      faults,
      logger,
      metrics,
      tracer,
      enrich: contextEnricher,
      applier: TransactionApplier.create(),
      outcomeMapper,
      anomalyDetector: new AnomalyDetector(),
    },
    { pendingTtlMs: config.PENDING_TTL_MS },
  );
  const markFailed = new MarkTransactionFailedUseCase({
    uow,
    clock,
    ids,
    hasher,
    logger,
    metrics,
    tracer,
    enrich: contextEnricher,
    outcomeMapper,
  });
  return new MessageProcessor(
    { submit, markFailed, hasher, breaker, metrics, logger },
    {
      supportedCurrencies: config.SUPPORTED_CURRENCIES,
      maxReceiveCount: config.CONSUMER_MAX_RECEIVE_COUNT,
      processingTimeoutMs: config.CONSUMER_PROCESSING_TIMEOUT_MS,
    },
  );
};

@Module({})
export class ConsumerModule {
  static register(options: ConsumerModuleOptions): DynamicModule {
    return {
      module: ConsumerModule,
      providers: [
        {
          provide: CircuitBreaker,
          useFactory: (): CircuitBreaker =>
            new CircuitBreaker('consumer', options.probes, options.metrics, options.logger),
        },
        {
          provide: WagerTransactionConsumer,
          inject: [CircuitBreaker],
          useFactory: (breaker: CircuitBreaker): WagerTransactionConsumer => {
            const faults = faultInjectorFor(options.config);
            const tracer = options.tracer ?? new NoopTracer();
            return new WagerTransactionConsumer(
              {
                receiveClient: options.sqs.receive,
                client: options.sqs.default,
                queueUrl: options.queueUrl,
                processor: buildProcessor(options, breaker, faults, tracer),
                mover: new DlqMover(
                  options.sqs.default,
                  { queueUrl: options.queueUrl, dlqUrl: options.dlqUrl },
                  new Uuidv7IdGenerator(),
                  options.metrics,
                  options.logger,
                ),
                breaker,
                faults,
                logger: options.logger,
                tracer,
              },
              {
                waitTimeSeconds: options.config.SQS_RECEIVE_WAIT_SECONDS,
                visibilityTimeoutSeconds: options.config.CONSUMER_VISIBILITY_TIMEOUT_SECONDS,
                heartbeatMs: options.config.CONSUMER_VISIBILITY_HEARTBEAT_MS,
              },
            );
          },
        },
        {
          provide: ConsumerResources,
          useFactory: (): ConsumerResources => new ConsumerResources(options.closeResources),
        },
      ],
    };
  }
}
