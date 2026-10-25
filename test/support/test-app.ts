import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { GetQueueAttributesCommand, GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { DynamicModule, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import type { DestinationStream, Logger as PinoLogger } from 'pino';
import { loadConfig } from '@infrastructure/config/env.schema';
import type { AppConfig } from '@infrastructure/config/env.schema';
import { createSqsClients, destroySqsClients } from '@infrastructure/messaging/sqs.client';
import type { SqsClients } from '@infrastructure/messaging/sqs.client';
import { createLogger } from '@infrastructure/observability/logger';
import { createMetricsRegistry } from '@infrastructure/observability/metrics.registry';
import { PinoLoggerAdapter } from '@infrastructure/observability/pino-logger.adapter';
import { PromMetricsAdapter } from '@infrastructure/observability/prom-metrics.adapter';
import { closeOrmInstances, openOrmInstances } from '@infrastructure/persistence/orm-instances';
import type { OrmInstances } from '@infrastructure/persistence/orm-instances';
import type { ReadinessProbes } from '@interfaces/health/readiness.service';
import { useJsonBodyParser } from '@interfaces/http/body-parser-error.middleware';
import type { QueueUrls } from '../../scripts/queues-init';
import { TestIssuer } from './test-issuer';
import { createTestQueues } from './test-queues';

export const testAppRoles = ['api', 'consumer', 'outbox', 'scheduler', 'events-audit'] as const;

export type TestAppRole = (typeof testAppRoles)[number];

export const TEST_APP_CONFIG: Readonly<Record<string, string>> = {
  OUTBOX_LEASE_MS: '2000',
  PENDING_LEASE_MS: '2000',
  CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '5',
  CONSUMER_VISIBILITY_HEARTBEAT_MS: '1500',
  CONSUMER_MAX_RECEIVE_COUNT: '3',
  PENDING_MAX_DETERMINISTIC_ERRORS: '2',
  SQS_RECEIVE_WAIT_SECONDS: '1',
  ENABLE_FAULT_INJECTION: 'false',
  FAULT_POINTS: '',
};

export interface TestAppOptions {
  readonly roles: readonly TestAppRole[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly logDestination?: DestinationStream;
}

export interface TestApp {
  readonly baseUrl: string;
  readonly config: AppConfig;
  readonly orm: OrmInstances;
  readonly sqs: SQSClient;
  readonly queueUrls: QueueUrls;
  readonly issuer: TestIssuer;
  stop(): Promise<void>;
}

export class TestAppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestAppError';
  }
}

interface SharedResources {
  readonly config: AppConfig;
  readonly orm: OrmInstances;
  readonly sqs: SqsClients;
  readonly queueUrls: QueueUrls;
  readonly destination: DestinationStream;
}

interface RegistrableModule<TOptions> {
  register(options: TOptions): DynamicModule;
}

interface StartedRole {
  readonly context: INestApplicationContext;
  readonly baseUrl: string | undefined;
}

type Closer = () => Promise<void>;

const activeLogDestinations = new Set<DestinationStream>();

const sharedLogSink: DestinationStream = {
  write(chunk: string): void {
    for (const destination of activeLogDestinations) {
      destination.write(chunk);
    }
  },
};

const releaseResources = (): Promise<void> => Promise.resolve();

const pascalCase = (role: TestAppRole): string =>
  role
    .split('-')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('');

const isRegistrableModule = <TOptions>(value: unknown): value is RegistrableModule<TOptions> =>
  typeof value === 'function' && typeof Reflect.get(value, 'register') === 'function';

const loadRoleModule = async <TOptions>(
  role: TestAppRole,
): Promise<RegistrableModule<TOptions>> => {
  const loaded: unknown = await import(`@bootstrap/${role}.module`);
  const exportName = `${pascalCase(role)}Module`;
  const candidate: unknown =
    typeof loaded === 'object' && loaded !== null ? Reflect.get(loaded, exportName) : undefined;
  if (!isRegistrableModule<TOptions>(candidate)) {
    throw new TestAppError(`@bootstrap/${role}.module does not export ${exportName}.register`);
  }
  return candidate;
};

const resolveQueueUrl = async (client: SQSClient, queueName: string): Promise<string> => {
  const found = await client.send(new GetQueueUrlCommand({ QueueName: queueName }));
  if (found.QueueUrl === undefined) {
    throw new TestAppError(`queue ${queueName} was not found`);
  }
  return found.QueueUrl;
};

const resolveQueueUrls = async (client: SQSClient, config: AppConfig): Promise<QueueUrls> => ({
  wagerTransactions: await resolveQueueUrl(client, config.WAGER_QUEUE_NAME),
  wagerTransactionsDlq: await resolveQueueUrl(client, config.WAGER_DLQ_NAME),
  walletEvents: await resolveQueueUrl(client, config.EVENTS_QUEUE_NAME),
});

const probesFor = (resources: SharedResources, queueUrl: string): ReadinessProbes => ({
  database: async (): Promise<void> => {
    await resources.orm.main.em.fork().execute('select 1');
  },
  queue: async (): Promise<void> => {
    await resources.sqs.default.send(
      new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
    );
  },
});

const pinoLoggerFor = (resources: SharedResources, role: TestAppRole): PinoLogger =>
  createLogger(
    {
      level: resources.config.LOG_LEVEL,
      service: role,
      instanceId: resources.config.INSTANCE_ID,
    },
    resources.destination,
  );

const workerOptions = (resources: SharedResources, role: TestAppRole) => ({
  config: resources.config,
  orm: resources.orm,
  logger: new PinoLoggerAdapter(pinoLoggerFor(resources, role)),
  metrics: new PromMetricsAdapter(createMetricsRegistry().metrics),
  closeResources: releaseResources,
});

const moduleOptionsFor = (resources: SharedResources, role: TestAppRole): object => {
  const { queueUrls, sqs } = resources;
  switch (role) {
    case 'api':
      return {
        config: resources.config,
        orm: resources.orm,
        probes: probesFor(resources, queueUrls.wagerTransactions),
        logger: pinoLoggerFor(resources, role),
        metrics: createMetricsRegistry(),
        closeResources: releaseResources,
      };
    case 'consumer':
      return {
        ...workerOptions(resources, role),
        sqs,
        queueUrl: queueUrls.wagerTransactions,
        dlqUrl: queueUrls.wagerTransactionsDlq,
        probes: probesFor(resources, queueUrls.wagerTransactions),
      };
    case 'outbox':
      return {
        ...workerOptions(resources, role),
        sqs,
        eventsQueueUrl: queueUrls.walletEvents,
        probes: probesFor(resources, queueUrls.walletEvents),
      };
    case 'scheduler':
      return {
        ...workerOptions(resources, role),
        sqs: sqs.default,
        dlqUrl: queueUrls.wagerTransactionsDlq,
        probes: probesFor(resources, queueUrls.wagerTransactions),
      };
    case 'events-audit':
      return {
        ...workerOptions(resources, role),
        sqs,
        queueUrl: queueUrls.walletEvents,
        probes: probesFor(resources, queueUrls.walletEvents),
      };
  }
};

const listeningUrl = (app: NestExpressApplication): string => {
  const address: unknown = app.getHttpServer().address();
  const port: unknown =
    typeof address === 'object' && address !== null ? Reflect.get(address, 'port') : undefined;
  if (typeof port !== 'number') {
    throw new TestAppError('api is not listening on a TCP port');
  }
  return `http://127.0.0.1:${String(port)}`;
};

const startRole = async (resources: SharedResources, role: TestAppRole): Promise<StartedRole> => {
  const roleModule = await loadRoleModule<object>(role);
  const dynamicModule = roleModule.register(moduleOptionsFor(resources, role));
  if (role !== 'api') {
    const context = await NestFactory.createApplicationContext(dynamicModule, { logger: false });
    return { context, baseUrl: undefined };
  }
  const app = await NestFactory.create<NestExpressApplication>(dynamicModule, {
    bodyParser: false,
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  useJsonBodyParser(app);
  await app.listen(0, '127.0.0.1');
  return { context: app, baseUrl: listeningUrl(app) };
};

const closeAll = async (closers: Closer[]): Promise<void> => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
};

const requireRoles = (roles: readonly TestAppRole[]): TestAppRole => {
  const [first] = roles;
  if (first === undefined) {
    throw new TestAppError('createTestApp needs at least one role');
  }
  if (new Set(roles).size !== roles.length) {
    throw new TestAppError('createTestApp received a repeated role');
  }
  return first;
};

const rejectFaultInjection = (config: AppConfig): void => {
  if (config.ENABLE_FAULT_INJECTION || config.FAULT_POINTS.length > 0) {
    throw new TestAppError(
      'fault points kill the whole process; use spawnInstances for fault injection tests',
    );
  }
};

const hasQueueNames = (env: Readonly<Record<string, string | undefined>>): boolean =>
  [env.WAGER_QUEUE_NAME, env.WAGER_DLQ_NAME, env.EVENTS_QUEUE_NAME].every(
    (name) => name !== undefined && name !== '',
  );

const queueEnvFor = async (
  env: Readonly<Record<string, string | undefined>>,
): Promise<Readonly<Record<string, string>>> =>
  hasQueueNames(env) ? {} : (await createTestQueues()).env;

const discardLines: DestinationStream = {
  write(): void {
    return undefined;
  },
};

export const createTestApp = async (options: TestAppOptions): Promise<TestApp> => {
  const firstRole = requireRoles(options.roles);
  const preview = loadConfig({ ...TEST_APP_CONFIG, ...options.env }, { role: firstRole });
  rejectFaultInjection(preview);
  const closers: Closer[] = [];
  const destination = options.logDestination ?? discardLines;
  activeLogDestinations.add(destination);
  closers.push(() => {
    activeLogDestinations.delete(destination);
    return Promise.resolve();
  });
  try {
    const issuer = await TestIssuer.start();
    closers.push(() => issuer.stop());
    const config = loadConfig(
      {
        ...(await queueEnvFor(options.env)),
        ...TEST_APP_CONFIG,
        INSTANCE_ID: `test-app-${randomUUID()}`,
        ...issuer.authConfig,
        ...options.env,
      },
      { role: firstRole },
    );
    rejectFaultInjection(config);
    const orm = await openOrmInstances(config);
    closers.push(() => closeOrmInstances(orm));
    const sqs = createSqsClients(config);
    closers.push(() => {
      destroySqsClients(sqs);
      return Promise.resolve();
    });
    const queueUrls = await resolveQueueUrls(sqs.default, config);
    const resources: SharedResources = {
      config,
      orm,
      sqs,
      queueUrls,
      destination: sharedLogSink,
    };
    let baseUrl: string | undefined;
    for (const role of options.roles) {
      const started = await startRole(resources, role);
      closers.push(() => started.context.close());
      baseUrl ??= started.baseUrl;
    }
    return {
      get baseUrl(): string {
        if (baseUrl === undefined) {
          throw new TestAppError('the api role is not running in this test app');
        }
        return baseUrl;
      },
      config,
      orm,
      sqs: sqs.default,
      queueUrls,
      issuer,
      stop: () => closeAll(closers),
    };
  } catch (error) {
    await closeAll(closers);
    throw error;
  }
};
