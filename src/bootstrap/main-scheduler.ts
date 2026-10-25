import 'reflect-metadata';
import { GetQueueAttributesCommand, GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { NestFactory } from '@nestjs/core';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import { loadConfig } from '@infrastructure/config/env.schema';
import { createSqsClient } from '@infrastructure/messaging/sqs.client';
import { createLogger } from '@infrastructure/observability/logger';
import { createMetricsRegistry } from '@infrastructure/observability/metrics.registry';
import { PinoLoggerAdapter } from '@infrastructure/observability/pino-logger.adapter';
import { PromMetricsAdapter } from '@infrastructure/observability/prom-metrics.adapter';
import { closeOrmInstances, openOrmInstances } from '@infrastructure/persistence/orm-instances';
import type { OrmInstances } from '@infrastructure/persistence/orm-instances';
import type { BreakerProbes } from '@interfaces/sqs/circuit-breaker';
import { SCHEDULER_COMPONENT } from '@interfaces/workers/pending-reference.worker';
import { startHealthServer } from './health-server';
import { SchedulerModule } from './scheduler.module';

type Closer = () => Promise<void>;

const resolveQueueUrl = async (client: SQSClient, queueName: string): Promise<string> => {
  const found = await client.send(new GetQueueUrlCommand({ QueueName: queueName }));
  if (found.QueueUrl === undefined) {
    throw new TechnicalError(ErrorClass.Permanent, 'queue_permanent');
  }
  return found.QueueUrl;
};

const buildProbes = (orm: OrmInstances, client: SQSClient, queueUrl: string): BreakerProbes => ({
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

const config = loadConfig(process.env, { role: 'scheduler' });
const pinoLogger = createLogger({
  level: config.LOG_LEVEL,
  service: SCHEDULER_COMPONENT,
  instanceId: config.INSTANCE_ID,
});
const logger = new PinoLoggerAdapter(pinoLogger);
const metrics = new PromMetricsAdapter(createMetricsRegistry().metrics);
const closers: Closer[] = [];

try {
  const orm = await openOrmInstances(config);
  closers.push(() => closeOrmInstances(orm));
  const sqs = createSqsClient(config, config.SQS_REQUEST_TIMEOUT_MS);
  closers.push(() => {
    sqs.destroy();
    return Promise.resolve();
  });
  const queueUrl = await resolveQueueUrl(sqs, config.WAGER_QUEUE_NAME);
  const probes = buildProbes(orm, sqs, queueUrl);
  const health = await startHealthServer({ port: config.HTTP_PORT, probes });
  closers.push(() => health.close());
  const app = await NestFactory.createApplicationContext(
    SchedulerModule.register({
      config,
      orm,
      probes,
      logger,
      metrics,
      closeResources: () => closeAll(closers.splice(0)),
    }),
    { logger: false },
  );
  app.enableShutdownHooks();
  logger.info('scheduler started', { component: SCHEDULER_COMPONENT });
} catch (error) {
  pinoLogger.error({ err: error }, 'scheduler failed to start');
  await closeAll(closers.splice(0));
  process.exitCode = 1;
}
