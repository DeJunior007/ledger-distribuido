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
import { IdGeneratorPort } from '@application/ports/id-generator.port';
import { LoggerPort } from '@application/ports/logger.port';
import { MetricsPort } from '@application/ports/metrics.port';
import { ProviderIdentityPort } from '@application/ports/provider-identity.port';
import { JwksTokenVerifier } from '@infrastructure/auth/jwks-token-verifier';
import { JwtProviderIdentityAdapter } from '@infrastructure/auth/jwt-provider-identity.adapter';
import type { AppConfig } from '@infrastructure/config/env.schema';
import { createHttpLoggerModule } from '@infrastructure/observability/logger.module';
import type { MetricsRegistry } from '@infrastructure/observability/metrics.registry';
import { PinoLoggerAdapter } from '@infrastructure/observability/pino-logger.adapter';
import { PromMetricsAdapter } from '@infrastructure/observability/prom-metrics.adapter';
import type { OrmInstances } from '@infrastructure/persistence/orm-instances';
import { Uuidv7IdGenerator } from '@infrastructure/system/uuidv7-id-generator';
import { HealthModule } from '@interfaces/health/health.module';
import type { ReadinessProbes } from '@interfaces/health/readiness.service';
import { AuthGuard } from '@interfaces/http/auth.guard';
import { CorrelationMiddleware, correlationIdsOf } from '@interfaces/http/correlation.middleware';
import { ProblemDetailsFilter } from '@interfaces/http/problem-details.filter';

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
      providers: [
        { provide: IdGeneratorPort, useFactory: (): IdGeneratorPort => new Uuidv7IdGenerator() },
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
