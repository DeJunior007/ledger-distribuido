import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Client } from 'pg';
import { ErrorClass } from '@application/errors/error-class';
import type { WagerTransactionRequest } from '@interfaces/http/schemas/wager-transaction.schema';
import { breakLedgerWrites, restoreGrants } from '@test/support/deterministic-failure';
import { betCommand, createWalletViaApi, toMessageData } from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import { spawnInstances } from '@test/support/spawn-instances';
import type { LogEntry, SpawnedInstance, SpawnedInstances } from '@test/support/spawn-instances';
import { buildEnvelope, createTestSqsClient, publishEnvelope } from '@test/support/sqs';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID, TestIssuer } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';
import type { TestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

const SENSITIVE_AMOUNT = '25.00';
const LOG_WAIT = { timeoutMs: 30_000 } as const;
const PROCESSED_WAIT = { timeoutMs: 60_000, intervalMs: 200 } as const;
const SETUP_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 90_000;
const PROVIDER_TOKEN = { role: 'provider', providerId: TEST_PROVIDER_ID } as const;
const DRIVER_MESSAGE_FRAGMENTS = ['insert into', 'permission denied', 'ledger_entries'] as const;

interface Environment {
  readonly database: TestDatabase;
  readonly queues: TestQueues;
  readonly issuer: TestIssuer;
  readonly sqs: SQSClient;
  readonly api: SpawnedInstances;
  readonly consumer: SpawnedInstances;
  readonly providerToken: string;
  readonly wallet: TestWallet;
}

interface Submission {
  readonly response: Response;
  readonly correlationId: string;
}

class LogsEnvironmentError extends Error {
  constructor() {
    super('the logs environment was not started');
    this.name = 'LogsEnvironmentError';
  }
}

let environment: Environment | undefined;

const env = (): Environment => {
  if (environment === undefined) {
    throw new LogsEnvironmentError();
  }
  return environment;
};

const apiInstance = (): SpawnedInstance => env().api.instance(0);

const consumerInstance = (): SpawnedInstance => env().consumer.instance(0);

const submitWithCorrelation = async (request: WagerTransactionRequest): Promise<Submission> => {
  const correlationId = `corr-${randomUUID()}`;
  const response = await fetch(`${apiInstance().baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env().providerToken}`,
      'Idempotency-Key': request.idempotencyKey,
      'X-Correlation-Id': correlationId,
    },
    body: JSON.stringify(request.body),
  });
  return { response, correlationId };
};

const capturedText = (instance: SpawnedInstance): string =>
  [...instance.stdoutLines(), ...instance.stderrLines()].join('\n');

const expectNoSensitiveData = (text: string, request: WagerTransactionRequest): void => {
  expect(text).not.toContain(env().providerToken);
  expect(text).not.toContain(SENSITIVE_AMOUNT);
  expect(text).not.toContain(JSON.stringify(request.body));
  expect(text).not.toContain(request.body.roundId);
};

const expectNoDriverMessage = (text: string): void => {
  for (const fragment of DRIVER_MESSAGE_FRAGMENTS) {
    expect(text.toLowerCase()).not.toContain(fragment);
  }
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const transactionIdOf = (body: unknown): unknown =>
  isRecord(body) ? body.transactionId : undefined;

const statusOf = async (request: WagerTransactionRequest): Promise<unknown> => {
  const client = new Client({ connectionString: env().database.superuserUrl });
  await client.connect();
  try {
    const result = await client.query<{ status: string }>(
      'select status from wager_transactions where provider_id = $1 and idempotency_key = $2',
      [TEST_PROVIDER_ID, request.idempotencyKey],
    );
    return result.rows[0]?.status;
  } finally {
    await client.end();
  }
};

beforeAll(async () => {
  const database = await createTestDatabase();
  const queues = await createTestQueues();
  const issuer = await TestIssuer.start();
  const processEnv = { DATABASE_URL: database.appUrl, ...queues.env, ...issuer.authConfig };
  const api = await spawnInstances({ role: 'api', count: 1, env: processEnv });
  const consumer = await spawnInstances({ role: 'consumer', count: 1, env: processEnv });
  const operatorToken = await issuer.token({ role: 'operator' });
  const wallet = await createWalletViaApi(api.instance(0).baseUrl, operatorToken);
  environment = {
    database,
    queues,
    issuer,
    sqs: createTestSqsClient(),
    api,
    consumer,
    providerToken: await issuer.token(PROVIDER_TOKEN),
    wallet,
  };
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  if (environment === undefined) {
    return;
  }
  environment.sqs.destroy();
  await environment.consumer.stop();
  await environment.api.stop();
  await environment.issuer.stop();
});

describe('structured logs', () => {
  it('logs an HTTP submission with its ids and without token, amount or body', async () => {
    const bet = betCommand({ wallet: env().wallet, amount: SENSITIVE_AMOUNT });
    const { response, correlationId } = await submitWithCorrelation(bet);
    expect(response.status).toBe(200);
    const transactionId = transactionIdOf(await response.json());

    const entry = await apiInstance().waitForLog(
      (line: LogEntry) => line.correlationId === correlationId && line.statusCode !== undefined,
      LOG_WAIT,
    );

    expect(entry).toMatchObject({
      correlationId,
      requestId: response.headers.get('x-request-id'),
      transactionId,
      walletId: env().wallet.id,
      providerId: TEST_PROVIDER_ID,
      component: 'api',
    });
    expect(typeof transactionId).toBe('string');
    expectNoSensitiveData(capturedText(apiInstance()), bet);
  });

  it(
    'logs a queued submission and a provoked database error with the ids and without the driver message',
    async () => {
      const bet = betCommand({ wallet: env().wallet, amount: SENSITIVE_AMOUNT });
      const envelope = buildEnvelope({ data: toMessageData(bet) });
      const correlationId = `corr-${randomUUID()}`;
      await breakLedgerWrites(env().database);
      try {
        await publishEnvelope(env().sqs, env().queues.urls.wagerTransactions, envelope, {
          correlationId,
        });

        const entry = await consumerInstance().waitForLog(
          (line: LogEntry) => line.messageId === envelope.messageId,
          LOG_WAIT,
        );

        expect(entry).toMatchObject({
          correlationId,
          messageId: envelope.messageId,
          walletId: env().wallet.id,
          providerId: TEST_PROVIDER_ID,
          errorClass: ErrorClass.Deterministic,
        });
        expect(typeof entry.transactionId).toBe('string');
      } finally {
        await restoreGrants(env().database);
      }
      await waitFor(async () => (await statusOf(bet)) === 'PROCESSED', PROCESSED_WAIT);

      const text = capturedText(consumerInstance());
      expectNoSensitiveData(text, bet);
      expectNoDriverMessage(text);
    },
    TEST_TIMEOUT_MS,
  );

  it('logs a provoked database error on HTTP without the SQL or its values', async () => {
    const bet = betCommand({ wallet: env().wallet, amount: SENSITIVE_AMOUNT });
    await breakLedgerWrites(env().database);
    let submission: Submission;
    try {
      submission = await submitWithCorrelation(bet);
    } finally {
      await restoreGrants(env().database);
    }
    expect(submission.response.status).toBe(503);

    const entry = await apiInstance().waitForLog(
      (line: LogEntry) => line.correlationId === submission.correlationId && line.err !== undefined,
      LOG_WAIT,
    );

    expect(entry).toMatchObject({
      providerId: TEST_PROVIDER_ID,
      walletId: env().wallet.id,
      err: { name: 'TechnicalError', code: '42501' },
    });
    const text = capturedText(apiInstance());
    expectNoSensitiveData(text, bet);
    expectNoDriverMessage(text);
  });
});
