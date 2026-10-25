import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import {
  betCommand,
  createWalletViaApi,
  submitViaApi,
  walletRequest,
} from '@test/support/fixtures';
import { registerCurrentDatabase } from '@test/support/current-database';
import { createTestApp } from '@test/support/test-app';
import type { TestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID } from '@test/support/test-issuer';

type Json = Readonly<Record<string, unknown>>;

interface RouteRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
}

class UnexpectedBodyError extends Error {
  constructor(body: unknown) {
    super(`expected a json object body, got ${JSON.stringify(body)}`);
    this.name = 'UnexpectedBodyError';
  }
}

const isJson = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const jsonOf = async (response: Response): Promise<Json> => {
  const parsed: unknown = await response.json();
  if (!isJson(parsed)) {
    throw new UnexpectedBodyError(parsed);
  }
  return parsed;
};

const walletCreation = (): RouteRequest => ({
  method: 'POST',
  path: '/wallets',
  body: walletRequest(),
});

const wagerSubmission = (): RouteRequest => ({
  method: 'POST',
  path: '/wagering/transactions',
  body: betCommand({ wallet: { id: randomUUID(), playerId: randomUUID() } }).body,
});

const protectedRoutes = (): readonly RouteRequest[] => {
  const walletId = randomUUID();
  return [
    walletCreation(),
    { method: 'GET', path: `/wallets/${walletId}` },
    { method: 'GET', path: `/wallets/${walletId}/ledger` },
    { method: 'POST', path: `/wallets/${walletId}/reconciliation` },
    wagerSubmission(),
    { method: 'GET', path: `/wagering/transactions/${randomUUID()}` },
    {
      method: 'GET',
      path: `/providers/${TEST_PROVIDER_ID}/wagering/transactions/ext-${randomUUID()}`,
    },
  ];
};

const TABLE_TOTALS_SQL = `SELECT
  (SELECT count(*)::int FROM wallets) AS wallets,
  (SELECT count(*)::int FROM wager_transactions) AS transactions,
  (SELECT count(*)::int FROM ledger_entries) AS entries,
  (SELECT count(*)::int FROM idempotency_records) AS idempotency,
  (SELECT count(*)::int FROM outbox_messages) AS outbox`;

let database: TestDatabase;
let app: TestApp;

const send = (request: RouteRequest, token: string | undefined): Promise<Response> =>
  fetch(`${app.baseUrl}${request.path}`, {
    method: request.method,
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `idem-${randomUUID()}`,
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  });

const tableTotals = async (): Promise<Json[]> => {
  const client = new Client({ connectionString: database.superuserUrl });
  await client.connect();
  try {
    return (await client.query<Json>(TABLE_TOTALS_SQL)).rows;
  } finally {
    await client.end();
  }
};

const expectFailure = async (
  response: Response,
  status: number,
  failureCode: string,
): Promise<void> => {
  expect(response.status).toBe(status);
  expect(await jsonOf(response)).toMatchObject({ status, failureCode });
};

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ roles: ['api'], env: { DATABASE_URL: database.appUrl } });
});

beforeEach(() => {
  registerCurrentDatabase(database.superuserUrl);
});

afterAll(async () => {
  await app.stop();
});

describe('§2 autenticação por Identity Provider externo', () => {
  it('answers 401 without a token on every non-public route and writes nothing', async () => {
    const before = await tableTotals();

    for (const route of protectedRoutes()) {
      const response = await send(route, undefined);

      expect(response.headers.get('www-authenticate')).toBe('Bearer');
      await expectFailure(response, 401, 'UNAUTHENTICATED');
    }
    expect(await tableTotals()).toEqual(before);
  });

  it('answers 401 to a token with the wrong issuer, the wrong audience or an expired one', async () => {
    const tokens = [
      await app.issuer.wrongIssuer(),
      await app.issuer.wrongAudience(),
      await app.issuer.expired(),
    ];

    for (const token of tokens) {
      const response = await send({ method: 'GET', path: `/wallets/${randomUUID()}` }, token);

      await expectFailure(response, 401, 'UNAUTHENTICATED');
    }
  });

  it('answers 403 to a valid token carrying the wrong role and writes nothing', async () => {
    const providerToken = await app.issuer.token({
      role: 'provider',
      providerId: TEST_PROVIDER_ID,
    });
    const operatorToken = await app.issuer.token({ role: 'operator' });
    const before = await tableTotals();

    await expectFailure(await send(walletCreation(), providerToken), 403, 'FORBIDDEN');
    await expectFailure(await send(wagerSubmission(), operatorToken), 403, 'FORBIDDEN');
    expect(await tableTotals()).toEqual(before);
  });

  it('answers 403 PROVIDER_IDENTITY_MISMATCH without writing when the body names another provider', async () => {
    const wallet = await createWalletViaApi(
      app.baseUrl,
      await app.issuer.token({ role: 'operator' }),
    );
    const providerToken = await app.issuer.token({
      role: 'provider',
      providerId: TEST_PROVIDER_ID,
    });
    const command = betCommand({ wallet, providerId: 'provider-b' });
    const before = await tableTotals();

    const response = await submitViaApi(app.baseUrl, providerToken, command);

    await expectFailure(response, 403, 'PROVIDER_IDENTITY_MISMATCH');
    expect(await tableTotals()).toEqual(before);
  });

  it('keeps health and metrics open without a token', async () => {
    for (const path of ['/health/live', '/health/ready', '/metrics']) {
      const response = await send({ method: 'GET', path }, undefined);

      expect(response.status).toBe(200);
    }
  });
});
