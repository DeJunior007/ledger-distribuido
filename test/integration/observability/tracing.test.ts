import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { ApiModule } from '@bootstrap/api.module';
import { ConsumerModule } from '@bootstrap/consumer.module';
import { EventsAuditModule } from '@bootstrap/events-audit.module';
import { OutboxModule } from '@bootstrap/outbox.module';
import { loadConfig } from '@infrastructure/config/env.schema';
import type { AppConfig } from '@infrastructure/config/env.schema';
import { createSqsClients, destroySqsClients } from '@infrastructure/messaging/sqs.client';
import type { SqsClients } from '@infrastructure/messaging/sqs.client';
import { createLogger } from '@infrastructure/observability/logger';
import { createMetricsRegistry } from '@infrastructure/observability/metrics.registry';
import { startTracing } from '@infrastructure/observability/otel';
import type { Tracing } from '@infrastructure/observability/otel';
import { PinoLoggerAdapter } from '@infrastructure/observability/pino-logger.adapter';
import { PromMetricsAdapter } from '@infrastructure/observability/prom-metrics.adapter';
import { closeOrmInstances, openOrmInstances } from '@infrastructure/persistence/orm-instances';
import type { OrmInstances } from '@infrastructure/persistence/orm-instances';
import { useJsonBodyParser } from '@interfaces/http/body-parser-error.middleware';
import {
  betCommand,
  createWalletViaApi,
  toMessageData,
  walletRequest,
} from '@test/support/fixtures';
import { buildEnvelope, publishEnvelope } from '@test/support/sqs';
import { TEST_APP_CONFIG } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import { TestIssuer } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';
import type { TestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

const SETUP_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 60_000;
const WAIT = { timeoutMs: 30_000, intervalMs: 200 } as const;
const SERVICE_NAME = 'tracing-test';
const BET_AMOUNT = '17.35';
const INITIAL_AMOUNT = '913.47';
const ID_ATTRIBUTES: readonly string[] = [
  'requestId',
  'correlationId',
  'messageId',
  'transactionId',
  'walletId',
  'providerId',
  'channel',
  'error.type',
  'http.method',
  'http.route',
];

interface Environment {
  readonly config: AppConfig;
  readonly orm: OrmInstances;
  readonly sqs: SqsClients;
  readonly queues: TestQueues;
  readonly issuer: TestIssuer;
  readonly exporter: InMemorySpanExporter;
  readonly tracing: Tracing;
  readonly contexts: readonly INestApplicationContext[];
  readonly baseUrl: string;
  readonly operatorToken: string;
}

class TracingEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TracingEnvironmentError';
  }
}

let environment: Environment | undefined;

const env = (): Environment => {
  if (environment === undefined) {
    throw new TracingEnvironmentError('the tracing environment was not started');
  }
  return environment;
};

const discardLines: DestinationStream = {
  write(): void {
    return undefined;
  },
};

const resolved = (): Promise<void> => Promise.resolve();

const listeningUrl = (app: NestExpressApplication): string => {
  const address: unknown = app.getHttpServer().address();
  const port: unknown =
    typeof address === 'object' && address !== null ? Reflect.get(address, 'port') : undefined;
  if (typeof port !== 'number') {
    throw new TracingEnvironmentError('api is not listening on a TCP port');
  }
  return `http://127.0.0.1:${String(port)}`;
};

const hex = (bytes: number): string => randomBytes(bytes).toString('hex');

const finishedSpans = async (): Promise<readonly ReadableSpan[]> => {
  await env().tracing.flush();
  return env().exporter.getFinishedSpans();
};

const spanIdOf = (span: ReadableSpan | undefined): string | undefined => span?.spanContext().spanId;

const traceIdOf = (span: ReadableSpan | undefined): string | undefined =>
  span?.spanContext().traceId;

const childOf = (
  spans: readonly ReadableSpan[],
  parent: ReadableSpan | undefined,
  name: string,
): ReadableSpan | undefined =>
  spans.find(
    (span) =>
      span.name === name &&
      parent !== undefined &&
      span.parentSpanContext?.spanId === spanIdOf(parent),
  );

const inTrace = (spans: readonly ReadableSpan[], traceId: string): readonly ReadableSpan[] =>
  spans.filter((span) => span.spanContext().traceId === traceId);

const expectOnlyIdAttributes = (spans: readonly ReadableSpan[]): void => {
  const keys = new Set(spans.flatMap((span) => Object.keys(span.attributes)));
  const values = spans.flatMap((span) => Object.values(span.attributes).map(String));
  expect([...keys].filter((key) => !ID_ATTRIBUTES.includes(key))).toEqual([]);
  expect(
    values.filter((value) => value.includes(BET_AMOUNT) || value.includes(INITIAL_AMOUNT)),
  ).toEqual([]);
};

const startApi = async (
  config: AppConfig,
  orm: OrmInstances,
  tracing: Tracing,
): Promise<NestExpressApplication> => {
  const app = await NestFactory.create<NestExpressApplication>(
    ApiModule.register({
      config,
      orm,
      probes: { database: resolved, queue: resolved },
      logger: createLogger(
        { level: config.LOG_LEVEL, service: 'api', instanceId: config.INSTANCE_ID },
        discardLines,
      ),
      metrics: createMetricsRegistry(),
      tracer: tracing.tracer,
      closeResources: resolved,
    }),
    { bodyParser: false, bufferLogs: true },
  );
  app.useLogger(app.get(Logger));
  useJsonBodyParser(app);
  await app.listen(0, '127.0.0.1');
  return app;
};

const workerOptions = (
  config: AppConfig,
  orm: OrmInstances,
  tracing: Tracing,
  service: string,
) => ({
  config,
  orm,
  logger: new PinoLoggerAdapter(
    createLogger(
      { level: config.LOG_LEVEL, service, instanceId: config.INSTANCE_ID },
      discardLines,
    ),
  ),
  metrics: new PromMetricsAdapter(createMetricsRegistry().metrics),
  probes: { database: resolved, queue: resolved },
  tracer: tracing.tracer,
  closeResources: resolved,
});

const startWorkers = async (
  config: AppConfig,
  orm: OrmInstances,
  sqs: SqsClients,
  queues: TestQueues,
  tracing: Tracing,
): Promise<INestApplicationContext[]> => [
  await NestFactory.createApplicationContext(
    ConsumerModule.register({
      ...workerOptions(config, orm, tracing, 'consumer'),
      sqs,
      queueUrl: queues.urls.wagerTransactions,
      dlqUrl: queues.urls.wagerTransactionsDlq,
    }),
    { logger: false },
  ),
  await NestFactory.createApplicationContext(
    OutboxModule.register({
      ...workerOptions(config, orm, tracing, 'outbox'),
      sqs,
      eventsQueueUrl: queues.urls.walletEvents,
    }),
    { logger: false },
  ),
  await NestFactory.createApplicationContext(
    EventsAuditModule.register({
      ...workerOptions(config, orm, tracing, 'events-audit'),
      sqs,
      queueUrl: queues.urls.walletEvents,
    }),
    { logger: false },
  ),
];

beforeAll(async () => {
  const database = await createTestDatabase();
  const queues = await createTestQueues();
  const issuer = await TestIssuer.start();
  const config = loadConfig(
    {
      ...queues.env,
      ...TEST_APP_CONFIG,
      INSTANCE_ID: `tracing-${randomUUID()}`,
      ...issuer.authConfig,
      DATABASE_URL: database.appUrl,
      OTEL_ENABLED: 'true',
    },
    { role: 'api' },
  );
  const exporter = new InMemorySpanExporter();
  const tracing = startTracing({
    enabled: config.OTEL_ENABLED,
    endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
    serviceName: SERVICE_NAME,
    exporter,
  });
  const orm = await openOrmInstances(config);
  const sqs = createSqsClients(config);
  const api = await startApi(config, orm, tracing);
  const workers = await startWorkers(config, orm, sqs, queues, tracing);
  environment = {
    config,
    orm,
    sqs,
    queues,
    issuer,
    exporter,
    tracing,
    contexts: [api, ...workers],
    baseUrl: listeningUrl(api),
    operatorToken: await issuer.token({ role: 'operator' }),
  };
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  const current = environment;
  environment = undefined;
  if (current === undefined) {
    return;
  }
  for (const context of [...current.contexts].reverse()) {
    await context.close();
  }
  await current.tracing.shutdown();
  destroySqsClients(current.sqs);
  await closeOrmInstances(current.orm);
  await current.issuer.stop();
}, SETUP_TIMEOUT_MS);

describe('tracing', () => {
  it(
    'nests the use case and the transaction under the http span and honours an incoming traceparent',
    async () => {
      const traceId = hex(16);
      const callerSpanId = hex(8);
      const correlationId = `corr-${randomUUID()}`;
      const response = await fetch(`${env().baseUrl}/wallets`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env().operatorToken}`,
          'X-Correlation-Id': correlationId,
          traceparent: `00-${traceId}-${callerSpanId}-01`,
        },
        body: JSON.stringify(
          walletRequest({ initialBalance: { amount: INITIAL_AMOUNT, currency: 'BRL' } }),
        ),
      });
      expect(response.status).toBe(201);
      const requestId = response.headers.get('X-Request-Id');

      let spans: readonly ReadableSpan[] = [];
      await waitFor(async () => {
        spans = inTrace(await finishedSpans(), traceId);
        return spans.some((span) => span.name === 'db.transaction');
      }, WAIT);

      const http = spans.find((span) => span.name === 'http.request');
      const useCase = childOf(spans, http, 'usecase.create_wallet');
      const transaction = childOf(spans, useCase, 'db.transaction');
      expect(http?.parentSpanContext?.spanId).toBe(callerSpanId);
      expect(http?.attributes).toEqual({
        requestId: requestId ?? 'missing',
        correlationId,
        'http.method': 'POST',
        'http.route': '/wallets',
      });
      expect(http?.resource.attributes['service.name']).toBe(SERVICE_NAME);
      expect(useCase).toBeDefined();
      expect(transaction).toBeDefined();
      expectOnlyIdAttributes(spans);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'does not open http spans for health and metrics but traces other routes without the query string',
    async () => {
      const marker = `corr-${randomUUID()}`;
      const headers = { 'X-Correlation-Id': marker };
      for (const path of ['/health/live', '/health/ready', '/metrics']) {
        await (await fetch(`${env().baseUrl}${path}`, { headers })).arrayBuffer();
      }
      const traced = await fetch(`${env().baseUrl}/wallets?probe=1`, {
        headers: { ...headers, Authorization: `Bearer ${env().operatorToken}` },
      });
      await traced.arrayBuffer();

      let mine: readonly ReadableSpan[] = [];
      await waitFor(async () => {
        mine = (await finishedSpans()).filter(
          (span) => span.name === 'http.request' && span.attributes.correlationId === marker,
        );
        return mine.length > 0;
      }, WAIT);

      expect(mine.map((span) => span.attributes['http.route'])).toEqual(['/wallets']);
      expect(mine.map((span) => span.attributes['http.method'])).toEqual(['GET']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'puts the outbox.publish traceparent on the event and events-audit continues that trace',
    async () => {
      await createWalletViaApi(env().baseUrl, env().operatorToken, {
        initialBalance: { amount: INITIAL_AMOUNT, currency: 'BRL' },
      });

      let spans: readonly ReadableSpan[] = [];
      let audited: ReadableSpan | undefined;
      await waitFor(async () => {
        spans = await finishedSpans();
        const publishIds = new Set(
          spans.filter((span) => span.name === 'outbox.publish').map((span) => spanIdOf(span)),
        );
        audited = spans.find(
          (span) => span.name === 'sqs.process' && publishIds.has(span.parentSpanContext?.spanId),
        );
        return audited !== undefined;
      }, WAIT);

      const publish = spans.find(
        (span) =>
          span.name === 'outbox.publish' && spanIdOf(span) === audited?.parentSpanContext?.spanId,
      );
      const batch = spans.find(
        (span) =>
          span.name === 'usecase.publish_outbox_batch' &&
          spanIdOf(span) === publish?.parentSpanContext?.spanId,
      );
      expect(traceIdOf(audited)).toBe(traceIdOf(publish));
      expect(traceIdOf(batch)).toBe(traceIdOf(publish));
      expect(Object.keys(audited?.attributes ?? {})).toEqual(['messageId']);
      expect(childOf(spans, audited, 'db.transaction')).toBeDefined();
      expectOnlyIdAttributes(inTrace(spans, traceIdOf(publish) ?? 'missing'));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'continues the trace of a traceparent message attribute in the consumer',
    async () => {
      const wallet = await createWalletViaApi(env().baseUrl, env().operatorToken, {
        initialBalance: { amount: INITIAL_AMOUNT, currency: 'BRL' },
      });
      const traceId = hex(16);
      const producerSpanId = hex(8);
      const envelope = buildEnvelope({
        data: toMessageData(betCommand({ wallet, amount: BET_AMOUNT })),
      });
      await publishEnvelope(env().sqs.default, env().queues.urls.wagerTransactions, envelope, {
        correlationId: `corr-${randomUUID()}`,
        traceparent: `00-${traceId}-${producerSpanId}-01`,
      });

      let spans: readonly ReadableSpan[] = [];
      await waitFor(async () => {
        spans = inTrace(await finishedSpans(), traceId);
        return spans.some((span) => span.name === 'sqs.process');
      }, WAIT);

      const processed = spans.find((span) => span.name === 'sqs.process');
      const useCase = childOf(spans, processed, 'usecase.submit_wager_transaction');
      expect(processed?.parentSpanContext?.spanId).toBe(producerSpanId);
      expect(processed?.attributes).toEqual({ messageId: envelope.messageId });
      expect(useCase?.attributes).toMatchObject({ walletId: wallet.id, channel: 'sqs' });
      expect(childOf(spans, useCase, 'db.transaction')).toBeDefined();
      expectOnlyIdAttributes(spans);
    },
    TEST_TIMEOUT_MS,
  );
});
