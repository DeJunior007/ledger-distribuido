import 'reflect-metadata';
import { GetQueueAttributesCommand, GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import { loadConfig } from '@infrastructure/config/env.schema';
import { createSqsClient } from '@infrastructure/messaging/sqs.client';
import { createLogger } from '@infrastructure/observability/logger';
import { createMetricsRegistry } from '@infrastructure/observability/metrics.registry';
import { startTracing } from '@infrastructure/observability/otel';
import { closeOrmInstances, openOrmInstances } from '@infrastructure/persistence/orm-instances';
import type { OrmInstances } from '@infrastructure/persistence/orm-instances';
import type { ReadinessProbes } from '@interfaces/health/readiness.service';
import { API_COMPONENT } from '@interfaces/http/correlation.middleware';
import { useJsonBodyParser } from '@interfaces/http/body-parser-error.middleware';
import { ApiModule } from './api.module';

type Closer = () => Promise<void>;

const resolveQueueUrl = async (client: SQSClient, queueName: string): Promise<string> => {
  const found = await client.send(new GetQueueUrlCommand({ QueueName: queueName }));
  if (found.QueueUrl === undefined) {
    throw new TechnicalError(ErrorClass.Permanent, 'queue_permanent');
  }
  return found.QueueUrl;
};

const buildProbes = (orm: OrmInstances, client: SQSClient, queueUrl: string): ReadinessProbes => ({
  database: async (): Promise<void> => {
    await orm.main.em.fork().execute('select 1');
  },
  queue: async (): Promise<void> => {
    await client.send(
      new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
    );
  },
});

const closeAll = async (closers: readonly Closer[]): Promise<void> => {
  for (const close of [...closers].reverse()) {
    await close();
  }
};

const config = loadConfig(process.env, { role: 'api' });
const logger = createLogger({
  level: config.LOG_LEVEL,
  service: API_COMPONENT,
  instanceId: config.INSTANCE_ID,
});
const closers: Closer[] = [];

try {
  const tracing = startTracing({
    enabled: config.OTEL_ENABLED,
    endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
    serviceName: API_COMPONENT,
  });
  closers.push(() => tracing.shutdown());
  const orm = await openOrmInstances(config);
  closers.push(() => closeOrmInstances(orm));
  const sqs = createSqsClient(config, config.SQS_REQUEST_TIMEOUT_MS);
  closers.push(() => {
    sqs.destroy();
    return Promise.resolve();
  });
  const queueUrl = await resolveQueueUrl(sqs, config.WAGER_QUEUE_NAME);
  const app = await NestFactory.create<NestExpressApplication>(
    ApiModule.register({
      tracer: tracing.tracer,
      config,
      orm,
      probes: buildProbes(orm, sqs, queueUrl),
      logger,
      metrics: createMetricsRegistry(),
      closeResources: () => closeAll(closers.splice(0)),
    }),
    { bodyParser: false, bufferLogs: true },
  );
  app.useLogger(app.get(Logger));
  useJsonBodyParser(app);
  app.enableShutdownHooks();
  await app.listen(config.HTTP_PORT);
  logger.info({ component: API_COMPONENT, port: config.HTTP_PORT }, 'api started');
} catch (error) {
  logger.error({ err: error }, 'api failed to start');
  await closeAll(closers.splice(0));
  process.exitCode = 1;
}
