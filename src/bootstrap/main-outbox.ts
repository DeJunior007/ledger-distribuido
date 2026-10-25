import 'reflect-metadata';
import { GetQueueAttributesCommand, GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { NestFactory } from '@nestjs/core';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import { loadConfig } from '@infrastructure/config/env.schema';
import { createSqsClients, destroySqsClients } from '@infrastructure/messaging/sqs.client';
import { createLogger } from '@infrastructure/observability/logger';
import { createMetricsRegistry } from '@infrastructure/observability/metrics.registry';
import { startTracing } from '@infrastructure/observability/otel';
import { PinoLoggerAdapter } from '@infrastructure/observability/pino-logger.adapter';
import { PromMetricsAdapter } from '@infrastructure/observability/prom-metrics.adapter';
import { closeOrmInstances, openOrmInstances } from '@infrastructure/persistence/orm-instances';
import type { OrmInstances } from '@infrastructure/persistence/orm-instances';
import type { BreakerProbes } from '@interfaces/sqs/circuit-breaker';
import { OUTBOX_COMPONENT } from '@interfaces/workers/outbox-publisher.worker';
import { startHealthServer } from './health-server';
import { OutboxModule } from './outbox.module';

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

const config = loadConfig(process.env, { role: 'outbox' });
const pinoLogger = createLogger({
  level: config.LOG_LEVEL,
  service: OUTBOX_COMPONENT,
  instanceId: config.INSTANCE_ID,
});
const logger = new PinoLoggerAdapter(pinoLogger);
const metrics = new PromMetricsAdapter(createMetricsRegistry().metrics);
const closers: Closer[] = [];

try {
  const tracing = startTracing({
    enabled: config.OTEL_ENABLED,
    endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
    serviceName: OUTBOX_COMPONENT,
  });
  closers.push(() => tracing.shutdown());
  const orm = await openOrmInstances(config);
  closers.push(() => closeOrmInstances(orm));
  const sqs = createSqsClients(config);
  closers.push(() => {
    destroySqsClients(sqs);
    return Promise.resolve();
  });
  const wagerQueueUrl = await resolveQueueUrl(sqs.default, config.WAGER_QUEUE_NAME);
  const eventsQueueUrl = await resolveQueueUrl(sqs.default, config.EVENTS_QUEUE_NAME);
  const health = await startHealthServer({
    port: config.HTTP_PORT,
    probes: buildProbes(orm, sqs.default, wagerQueueUrl),
  });
  closers.push(() => health.close());
  const app = await NestFactory.createApplicationContext(
    OutboxModule.register({
      tracer: tracing.tracer,
      config,
      orm,
      sqs,
      eventsQueueUrl,
      probes: buildProbes(orm, sqs.default, eventsQueueUrl),
      logger,
      metrics,
      closeResources: () => closeAll(closers.splice(0)),
    }),
    { logger: false },
  );
  app.enableShutdownHooks();
  logger.info('outbox started', { component: OUTBOX_COMPONENT });
} catch (error) {
  pinoLogger.error({ err: error }, 'outbox failed to start');
  await closeAll(closers.splice(0));
  process.exitCode = 1;
}
