import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { createMetricsRegistry } from '@infrastructure/observability/metrics.registry';
import { HealthModule } from '@interfaces/health/health.module';
import type { ReadinessProbes } from '@interfaces/health/readiness.service';

export interface HealthServerOptions {
  readonly port: number;
  readonly probes: ReadinessProbes;
}

export interface HealthServer {
  readonly url: string;
  close(): Promise<void>;
}

export const startHealthServer = async (options: HealthServerOptions): Promise<HealthServer> => {
  const app: INestApplication = await NestFactory.create(
    HealthModule.register({ probes: options.probes, metrics: createMetricsRegistry().registry }),
    { logger: false },
  );
  await app.listen(options.port);
  const url = await app.getUrl();
  return {
    url,
    close: async (): Promise<void> => {
      await app.close();
    },
  };
};
