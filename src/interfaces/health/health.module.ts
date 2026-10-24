import { Module, type DynamicModule } from '@nestjs/common';
import { HealthController } from './health.controller';
import { MetricsController, MetricsSource } from './metrics.controller';
import { ReadinessService, type ReadinessProbes } from './readiness.service';

export interface HealthModuleOptions {
  readonly probes: ReadinessProbes;
  readonly metrics: MetricsSource;
}

@Module({})
export class HealthModule {
  static register(options: HealthModuleOptions): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController, MetricsController],
      providers: [
        {
          provide: ReadinessService,
          useFactory: (): ReadinessService => new ReadinessService(options.probes),
        },
        { provide: MetricsSource, useValue: options.metrics },
      ],
    };
  }
}
