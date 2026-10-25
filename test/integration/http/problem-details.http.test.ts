import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { DriverException } from '@mikro-orm/core';
import { Body, Controller, Get, Module, Param, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import { ForbiddenError } from '@application/errors/forbidden.error';
import { NotFoundError } from '@application/errors/not-found.error';
import { UnauthenticatedError } from '@application/errors/unauthenticated.error';
import { WalletAlreadyExistsError } from '@application/errors/wallet-already-exists.error';
import { FAILURE_CODE_METADATA, FailureCode } from '@domain/shared/failure-code';
import { InvalidTransactionStateError } from '@domain/wagering/errors/invalid-transaction-state.error';
import { InvalidAmountError } from '@domain/wallet/errors/invalid-amount.error';
import { ApiModule } from '@bootstrap/api.module';
import { loadConfig } from '@infrastructure/config/env.schema';
import { createLogger } from '@infrastructure/observability/logger';
import { createMetricsRegistry } from '@infrastructure/observability/metrics.registry';
import { requestContext } from '@infrastructure/observability/request-context';
import type { RequestContext } from '@infrastructure/observability/request-context';
import { closeOrmInstances, openOrmInstances } from '@infrastructure/persistence/orm-instances';
import type { OrmInstances } from '@infrastructure/persistence/orm-instances';
import { useJsonBodyParser } from '@interfaces/http/body-parser-error.middleware';
import { RequestValidationError } from '@interfaces/http/zod-validation.pipe';
import { createTestDatabase } from '@test/support/test-database';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WALLET_ID = '0196c000-0000-7000-8000-000000000001';
const SECRET_VALUE = 'secret-4242';
const DRIVER_SQL = `select '${SECRET_VALUE}'::int as leaked`;
const PLAIN_ERROR_MESSAGE = 'unexpected plain failure with secret-9191';

type Json = Record<string, unknown>;

const isJson = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const logLines: string[] = [];

const logDestination: DestinationStream = {
  write(chunk: string) {
    logLines.push(chunk);
  },
};

const logEntries = (): Json[] =>
  logLines.map((line) => {
    const parsed: unknown = JSON.parse(line);
    return isJson(parsed) ? parsed : {};
  });

const errorLogFor = (requestId: string | null): Json | undefined =>
  logEntries().find((entry) => entry.message === 'request failed' && entry.requestId === requestId);

const captureDriverError = async (orm: OrmInstances): Promise<DriverException> => {
  const failure = await orm.main.em
    .fork()
    .execute(DRIVER_SQL)
    .then(
      () => undefined,
      (reason: unknown) => reason,
    );
  if (!(failure instanceof DriverException)) {
    throw new TypeError('expected the database to reject the probe query');
  }
  return failure;
};

const driverErrors: DriverException[] = [];

const driverError = (): DriverException => {
  const [captured] = driverErrors;
  if (captured === undefined) {
    throw new TypeError('driver error was not captured');
  }
  return captured;
};

const ERROR_FACTORIES: Readonly<Record<string, () => Error>> = {
  'pipe-validation': () =>
    new RequestValidationError(FailureCode.InvalidMoney, [
      { path: 'body.money.amount', message: 'amount must be a decimal string' },
    ]),
  'domain-validation': () => new InvalidAmountError('amount must be positive'),
  'domain-without-code': () => new InvalidTransactionStateError('transition not allowed'),
  unauthenticated: () => new UnauthenticatedError(),
  forbidden: () => new ForbiddenError(),
  'not-found': () => new NotFoundError(),
  'wallet-exists': () => new WalletAlreadyExistsError(WALLET_ID),
  transient: () => new TechnicalError(ErrorClass.Transient, 'serialization'),
  race: () => new TechnicalError(ErrorClass.Race, 'race'),
  'lock-timeout': () => new TechnicalError(ErrorClass.Transient, 'lock_timeout'),
  'version-mismatch': () => new TechnicalError(ErrorClass.Transient, 'version_mismatch'),
  connectivity: () =>
    new TechnicalError(ErrorClass.Connectivity, 'connection', { probe: 'database' }),
  permanent: () => new TechnicalError(ErrorClass.Permanent, 'queue_permanent'),
  deterministic: () =>
    new TechnicalError(ErrorClass.Deterministic, 'deterministic', { cause: driverError() }),
  driver: () => driverError(),
  plain: () => new TypeError(PLAIN_ERROR_MESSAGE),
};

@Controller('probe')
class ErrorProbeController {
  @Get('throw/:name')
  throwNamed(@Param('name') name: string): never {
    const create = ERROR_FACTORIES[name];
    throw create === undefined ? new NotFoundError() : create();
  }

  @Post('echo')
  echo(@Body() body: unknown): { readonly received: boolean } {
    return { received: isJson(body) };
  }

  @Get('context')
  context(): Readonly<Partial<RequestContext>> {
    return requestContext.current();
  }
}

@Module({})
class ProblemDetailsTestModule {}

interface RunningApp {
  readonly app: NestExpressApplication;
  readonly baseUrl: string;
}

const running: RunningApp[] = [];

const baseUrl = (): string => {
  const [current] = running;
  if (current === undefined) {
    throw new TypeError('test app is not running');
  }
  return current.baseUrl;
};

const get = (path: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${baseUrl()}${path}`, { headers });

const postRaw = (path: string, body: string, contentType = 'application/json'): Promise<Response> =>
  fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
  });

const readProblem = async (
  response: Response,
  status: number,
  failureCode: FailureCode,
): Promise<Json> => {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type') ?? '').toStartWith('application/problem+json');
  const body: unknown = await response.json();
  if (!isJson(body)) {
    throw new TypeError('problem body is not a JSON object');
  }
  const metadata = FAILURE_CODE_METADATA[failureCode];
  expect(body).toMatchObject({
    type: `urn:jungle:problem:${failureCode}`,
    status,
    failureCode,
    retryable: metadata.retryable,
    action: metadata.action,
  });
  expect(typeof body.title).toBe('string');
  expect(typeof body.detail).toBe('string');
  return body;
};

const lockConflicts = async (type: string): Promise<number> => {
  const metric = createMetricsRegistry().registry.getSingleMetric('jungle_lock_conflicts_total');
  if (metric === undefined) {
    throw new TypeError('lock conflicts metric is not registered');
  }
  const data = await metric.get();
  return data.values.find((sample) => sample.labels.type === type)?.value ?? 0;
};

beforeAll(async () => {
  const database = await createTestDatabase();
  const config = loadConfig({ DATABASE_URL: database.appUrl }, { role: 'api' });
  const orm = await openOrmInstances(config);
  driverErrors.push(await captureDriverError(orm));
  const logger = createLogger(
    { level: 'info', service: 'api', instanceId: 'api-test' },
    logDestination,
  );
  const app = await NestFactory.create<NestExpressApplication>(
    {
      module: ProblemDetailsTestModule,
      imports: [
        ApiModule.register({
          config,
          orm,
          probes: {
            database: async () => {
              await orm.main.em.fork().execute('select 1');
            },
            queue: () => Promise.reject(new TechnicalError(ErrorClass.Connectivity, 'connection')),
          },
          logger,
          metrics: createMetricsRegistry(),
          closeResources: () => closeOrmInstances(orm),
        }),
      ],
      controllers: [ErrorProbeController],
    },
    { bodyParser: false, bufferLogs: true },
  );
  app.useLogger(app.get(Logger));
  useJsonBodyParser(app);
  app.enableShutdownHooks();
  await app.listen(0, '127.0.0.1');
  running.push({ app, baseUrl: await app.getUrl() });
});

afterAll(async () => {
  for (const { app } of running.splice(0)) {
    await app.close();
  }
});

describe('ProblemDetailsFilter', () => {
  it('maps a pipe validation error to 400 with its code and errors', async () => {
    const body = await readProblem(
      await get('/probe/throw/pipe-validation'),
      400,
      FailureCode.InvalidMoney,
    );
    expect(body.errors).toEqual([
      { path: 'body.money.amount', message: 'amount must be a decimal string' },
    ]);
  });

  it('maps malformed JSON to 400 INVALID_PAYLOAD without the parser message', async () => {
    const response = await postRaw('/probe/echo', '{"amount": ');
    const body = await readProblem(response, 400, FailureCode.InvalidPayload);
    expect(JSON.stringify(body)).not.toContain('JSON Parse');
    expect(body.errors).toBeUndefined();
  });

  it('maps a body above 16 kb to 400 INVALID_PAYLOAD', async () => {
    const response = await postRaw('/probe/echo', JSON.stringify({ data: 'x'.repeat(17 * 1024) }));
    await readProblem(response, 400, FailureCode.InvalidPayload);
  });

  it('accepts a JSON body just under 16 kb', async () => {
    const response = await postRaw('/probe/echo', JSON.stringify({ data: 'x'.repeat(15 * 1024) }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ received: true });
  });

  it('maps an unknown route to 404 NOT_FOUND', async () => {
    await readProblem(await get('/does-not-exist'), 404, FailureCode.NotFound);
  });

  it('maps a domain validation error to 400 with its code', async () => {
    await readProblem(await get('/probe/throw/domain-validation'), 400, FailureCode.InvalidAmount);
  });

  it('maps application errors to the status of their code', async () => {
    const unauthenticated = await get('/probe/throw/unauthenticated');
    expect(unauthenticated.headers.get('www-authenticate')).toBe('Bearer');
    await readProblem(unauthenticated, 401, FailureCode.Unauthenticated);
    await readProblem(await get('/probe/throw/forbidden'), 403, FailureCode.Forbidden);
    await readProblem(await get('/probe/throw/not-found'), 404, FailureCode.NotFound);
    const conflict = await readProblem(
      await get('/probe/throw/wallet-exists'),
      409,
      FailureCode.WalletAlreadyExists,
    );
    expect(conflict.walletId).toBe(WALLET_ID);
  });

  it('maps transient and race technical errors to 503 with Retry-After 1', async () => {
    for (const name of ['transient', 'race', 'lock-timeout', 'version-mismatch']) {
      const response = await get(`/probe/throw/${name}`);
      expect(response.headers.get('retry-after')).toBe('1');
      await readProblem(response, 503, FailureCode.InfrastructureUnavailable);
    }
  });

  it('maps connectivity errors to 503 with Retry-After 5', async () => {
    const response = await get('/probe/throw/connectivity');
    expect(response.headers.get('retry-after')).toBe('5');
    await readProblem(response, 503, FailureCode.InfrastructureUnavailable);
  });

  it('counts lock timeouts and version mismatches', async () => {
    const lockTimeoutBefore = await lockConflicts('lock_timeout');
    const versionMismatchBefore = await lockConflicts('version_mismatch');
    await get('/probe/throw/lock-timeout');
    await get('/probe/throw/version-mismatch');
    await get('/probe/throw/version-mismatch');
    expect((await lockConflicts('lock_timeout')) - lockTimeoutBefore).toBe(1);
    expect((await lockConflicts('version_mismatch')) - versionMismatchBefore).toBe(2);
  });

  it('maps deterministic and unknown errors to 503 INTERNAL_ERROR with Retry-After 5', async () => {
    for (const name of ['deterministic', 'permanent', 'driver', 'domain-without-code', 'plain']) {
      const response = await get(`/probe/throw/${name}`);
      expect(response.headers.get('retry-after')).toBe('5');
      const requestId = response.headers.get('x-request-id');
      await readProblem(response, 503, FailureCode.InternalError);
      expect(errorLogFor(requestId)).toMatchObject({
        level: 50,
        failureCode: FailureCode.InternalError,
        requestId,
      });
    }
  });

  it('never exposes stack, SQL or driver messages in the body', async () => {
    expect(Reflect.get(driverError(), 'message')).toContain(SECRET_VALUE);
    for (const name of ['deterministic', 'driver', 'plain']) {
      const text = await (await get(`/probe/throw/${name}`)).text();
      expect(text).not.toContain(SECRET_VALUE);
      expect(text).not.toContain('::int');
      expect(text).not.toContain('secret-9191');
      expect(text).not.toContain('stack');
      expect(text).not.toContain('.ts:');
    }
  });

  it('logs driver failures through the safe serializer', async () => {
    const deterministic = await get('/probe/throw/deterministic');
    const driver = await get('/probe/throw/driver');
    const deterministicLog = errorLogFor(deterministic.headers.get('x-request-id'));
    const driverLog = errorLogFor(driver.headers.get('x-request-id'));
    expect(deterministicLog?.err).toEqual({
      name: 'TechnicalError',
      code: '22P02',
      reason: 'deterministic',
    });
    expect(driverLog?.err).toEqual({ name: driverError().name, code: '22P02' });
    const logged = logLines.join('\n');
    expect(logged).not.toContain(SECRET_VALUE);
    expect(logged).not.toContain('::int');
  });
});

describe('correlation headers', () => {
  it('returns a UUIDv7 X-Request-Id and echoes a valid X-Correlation-Id', async () => {
    const response = await get('/probe/context', { 'X-Correlation-Id': 'provider-corr-42' });
    const requestId = response.headers.get('x-request-id') ?? '';
    expect(requestId).toMatch(UUID_V7);
    expect(response.headers.get('x-correlation-id')).toBe('provider-corr-42');
    expect(await response.json()).toMatchObject({
      requestId,
      correlationId: 'provider-corr-42',
      component: 'api',
    });
  });

  it('replaces an invalid X-Correlation-Id with the request id', async () => {
    for (const invalid of ['has space', 'x'.repeat(129)]) {
      const response = await get('/probe/context', { 'X-Correlation-Id': invalid });
      const requestId = response.headers.get('x-request-id') ?? '';
      expect(requestId).toMatch(UUID_V7);
      expect(response.headers.get('x-correlation-id')).toBe(requestId);
    }
  });

  it('generates a new request id for every request, ignoring the client one', async () => {
    const first = await get('/probe/context', { 'X-Request-Id': 'client-chosen' });
    const second = await get('/probe/context');
    const firstId = first.headers.get('x-request-id') ?? '';
    expect(firstId).toMatch(UUID_V7);
    expect(firstId).not.toBe(second.headers.get('x-request-id'));
  });

  it('sets the correlation headers on body parser errors and unknown routes', async () => {
    const malformed = await postRaw('/probe/echo', '{');
    const missing = await get('/nowhere', { 'X-Correlation-Id': 'corr-404' });
    expect(malformed.headers.get('x-request-id') ?? '').toMatch(UUID_V7);
    expect(malformed.headers.get('x-correlation-id')).toBe(malformed.headers.get('x-request-id'));
    expect(missing.headers.get('x-request-id') ?? '').toMatch(UUID_V7);
    expect(missing.headers.get('x-correlation-id')).toBe('corr-404');
  });
});

describe('health routes behind the filter', () => {
  it('keeps the readiness 503 body of the health controller', async () => {
    const response = await get('/health/ready');
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type') ?? '').toStartWith('application/json');
    expect(await response.json()).toEqual({
      status: 'unavailable',
      checks: { database: 'up', queue: 'down' },
    });
  });

  it('answers liveness with 200', async () => {
    const response = await get('/health/live');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id') ?? '').toMatch(UUID_V7);
  });
});
