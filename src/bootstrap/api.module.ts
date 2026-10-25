import {
  Module,
  RequestMethod,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core';
import type { Logger } from 'pino';
import { ClockPort } from '@application/ports/clock.port';
import { HasherPort } from '@application/ports/hasher.port';
import { IdGeneratorPort } from '@application/ports/id-generator.port';
import { LoggerPort } from '@application/ports/logger.port';
import { MetricsPort } from '@application/ports/metrics.port';
import { ProviderIdentityPort } from '@application/ports/provider-identity.port';
import { TracerPort } from '@application/ports/tracer.port';
import { UnitOfWorkPort } from '@application/ports/unit-of-work.port';
import { CreateWalletUseCase } from '@application/use-cases/create-wallet.use-case';
import { GetWalletUseCase } from '@application/use-cases/get-wallet.use-case';
import { ListLedgerUseCase } from '@application/use-cases/list-ledger.use-case';
import { ReconcileWalletUseCase } from '@application/use-cases/reconcile-wallet.use-case';
import { JwksTokenVerifier } from '@infrastructure/auth/jwks-token-verifier';
import { JwtProviderIdentityAdapter } from '@infrastructure/auth/jwt-provider-identity.adapter';
import type { AppConfig } from '@infrastructure/config/env.schema';
import { contextEnricher } from '@infrastructure/observability/context-enricher';
import { createHttpLoggerModule } from '@infrastructure/observability/logger.module';
import type { MetricsRegistry } from '@infrastructure/observability/metrics.registry';
import { PinoLoggerAdapter } from '@infrastructure/observability/pino-logger.adapter';
import { PromMetricsAdapter } from '@infrastructure/observability/prom-metrics.adapter';
import { MikroOrmUnitOfWork } from '@infrastructure/persistence/mikro-orm-unit-of-work';
import type { OrmInstances } from '@infrastructure/persistence/orm-instances';
import { NoopTracer } from '@infrastructure/system/noop-tracer';
import { Sha256Hasher } from '@infrastructure/system/sha256-hasher';
import { SystemClock } from '@infrastructure/system/system-clock';
import { Uuidv7IdGenerator } from '@infrastructure/system/uuidv7-id-generator';
import { HealthModule } from '@interfaces/health/health.module';
import type { ReadinessProbes } from '@interfaces/health/readiness.service';
import { AuthGuard } from '@interfaces/http/auth.guard';
import { ReconciliationController } from '@interfaces/http/controllers/reconciliation.controller';
import {
  CreateWalletBodyPipe,
  WalletsController,
} from '@interfaces/http/controllers/wallets.controller';
import { CorrelationMiddleware, correlationIdsOf } from '@interfaces/http/correlation.middleware';
import { ProblemDetailsFilter } from '@interfaces/http/problem-details.filter';
import { createWalletSchema } from '@interfaces/http/schemas/create-wallet.schema';

export interface ApiModuleOptions {
  readonly config: AppConfig;
  readonly orm: OrmInstances;
  readonly probes: ReadinessProbes;
  readonly logger: Logger;
  readonly metrics: MetricsRegistry;
  readonly closeResources: () => Promise<void>;
}

export class ApiResources implements OnApplicationShutdown {
  constructor(private readonly closeResources: () => Promise<void>) {}

  async onApplicationShutdown(): Promise<void> {
    await this.closeResources();
  }
}

const ALL_ROUTES = { path: '{/*splat}', method: RequestMethod.ALL };

@Module({})
export class ApiModule implements NestModule {
  static register(options: ApiModuleOptions): DynamicModule {
    return {
      module: ApiModule,
      imports: [
        createHttpLoggerModule({ logger: options.logger, idsOf: correlationIdsOf }),
        HealthModule.register({ probes: options.probes, metrics: options.metrics.registry }),
      ],
      controllers: [WalletsController, ReconciliationController],
      providers: [
        { provide: IdGeneratorPort, useFactory: (): IdGeneratorPort => new Uuidv7IdGenerator() },
        { provide: ClockPort, useFactory: (): ClockPort => new SystemClock() },
        { provide: HasherPort, useFactory: (): HasherPort => new Sha256Hasher() },
        { provide: TracerPort, useFactory: (): TracerPort => new NoopTracer() },
        {
          provide: UnitOfWorkPort,
          useFactory: (): UnitOfWorkPort => new MikroOrmUnitOfWork(options.orm, options.config),
        },
        {
          provide: LoggerPort,
          useFactory: (): LoggerPort => new PinoLoggerAdapter(options.logger),
        },
        {
          provide: MetricsPort,
          useFactory: (): MetricsPort => new PromMetricsAdapter(options.metrics.metrics),
        },
        {
          provide: APP_FILTER,
          inject: [IdGeneratorPort, MetricsPort],
          useFactory: (ids: IdGeneratorPort, metrics: MetricsPort): ProblemDetailsFilter =>
            new ProblemDetailsFilter({ ids, metrics, logger: options.logger }),
        },
        {
          provide: ProviderIdentityPort,
          useFactory: (): ProviderIdentityPort =>
            new JwtProviderIdentityAdapter(new JwksTokenVerifier(options.config)),
        },
        {
          provide: APP_GUARD,
          inject: [Reflector, ProviderIdentityPort],
          useFactory: (reflector: Reflector, providerIdentity: ProviderIdentityPort): AuthGuard =>
            new AuthGuard(reflector, providerIdentity),
        },
        {
          provide: CreateWalletUseCase,
          inject: [
            UnitOfWorkPort,
            ClockPort,
            IdGeneratorPort,
            HasherPort,
            LoggerPort,
            MetricsPort,
            TracerPort,
          ],
          useFactory: (
            uow: UnitOfWorkPort,
            clock: ClockPort,
            ids: IdGeneratorPort,
            hasher: HasherPort,
            logger: LoggerPort,
            metrics: MetricsPort,
            tracer: TracerPort,
          ): CreateWalletUseCase =>
            new CreateWalletUseCase({
              uow,
              clock,
              ids,
              hasher,
              logger,
              metrics,
              tracer,
              enrich: contextEnricher,
            }),
        },
        {
          provide: GetWalletUseCase,
          inject: [UnitOfWorkPort],
          useFactory: (uow: UnitOfWorkPort): GetWalletUseCase => new GetWalletUseCase(uow),
        },
        {
          provide: ListLedgerUseCase,
          inject: [UnitOfWorkPort],
          useFactory: (uow: UnitOfWorkPort): ListLedgerUseCase => new ListLedgerUseCase(uow),
        },
        {
          provide: ReconcileWalletUseCase,
          inject: [UnitOfWorkPort, IdGeneratorPort, ClockPort, MetricsPort, LoggerPort],
          useFactory: (
            uow: UnitOfWorkPort,
            ids: IdGeneratorPort,
            clock: ClockPort,
            metrics: MetricsPort,
            logger: LoggerPort,
          ): ReconcileWalletUseCase => new ReconcileWalletUseCase(uow, ids, clock, metrics, logger),
        },
        {
          provide: CreateWalletBodyPipe,
          useFactory: (): CreateWalletBodyPipe =>
            new CreateWalletBodyPipe(
              createWalletSchema(options.config.SUPPORTED_CURRENCIES),
              'root',
            ),
        },
        {
          provide: ApiResources,
          useFactory: (): ApiResources => new ApiResources(options.closeResources),
        },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes(ALL_ROUTES);
  }
}
