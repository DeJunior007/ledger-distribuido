import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import {
  betCommand,
  createWalletViaApi,
  submitViaApi,
  walletRequest,
} from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import { createTestApp } from '@test/support/test-app';
import type { TestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID } from '@test/support/test-issuer';

const OTHER_PROVIDER_ID = 'provider-b';
const PROBLEM_CONTENT_TYPE = 'application/problem+json';
const CONNECTIVITY_RETRY_AFTER = '5';

type Json = Record<string, unknown>;
type Role = 'provider' | 'operator';

interface RouteRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

interface RouteCase {
  readonly name: string;
  readonly allowed: readonly Role[];
  readonly successStatus: number;
  build(): RouteRequest;
}

interface SubmittedTransaction {
  readonly id: string;
  readonly externalTransactionId: string;
}

const isJson = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

class UnexpectedBodyError extends Error {
  constructor(body: unknown) {
    super(`expected a json object, got ${JSON.stringify(body)}`);
    this.name = 'UnexpectedBodyError';
  }
}

const jsonOf = async (response: Response): Promise<Json> => {
  const body: unknown = await response.json();
  if (!isJson(body)) {
    throw new UnexpectedBodyError(body);
  }
  return body;
};

let database: TestDatabase;
let app: TestApp;
let operatorToken: string;
let providerToken: string;
let otherProviderToken: string;
let wallet: TestWallet;
let transaction: SubmittedTransaction;

const tokenFor = (role: Role): string => (role === 'operator' ? operatorToken : providerToken);

const send = (
  baseUrl: string,
  request: RouteRequest,
  authorization: string | undefined,
): Promise<Response> =>
  fetch(`${baseUrl}${request.path}`, {
    method: request.method,
    headers: {
      'Content-Type': 'application/json',
      ...request.headers,
      ...(authorization === undefined ? {} : { Authorization: authorization }),
    },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  });

const bearer = (token: string): string => `Bearer ${token}`;

const queryRows = async (sql: string, params: readonly unknown[] = []): Promise<Json[]> => {
  const client = new Client({ connectionString: database.superuserUrl });
  await client.connect();
  try {
    const result = await client.query<Json>(sql, [...params]);
    return result.rows;
  } finally {
    await client.end();
  }
};

const TABLE_TOTALS_SQL = `SELECT
  (SELECT count(*)::int FROM wager_transactions) AS transactions,
  (SELECT count(*)::int FROM ledger_entries) AS entries,
  (SELECT count(*)::int FROM idempotency_records) AS idempotency,
  (SELECT count(*)::int FROM outbox_messages) AS outbox,
  (SELECT count(*)::int FROM wallets) AS wallets`;

const tableTotals = (): Promise<Json[]> => queryRows(TABLE_TOTALS_SQL);

const walletState = (walletId: string): Promise<Json[]> =>
  queryRows('select balance::text as balance, version from wallets where id = $1', [walletId]);

const submitBet = async (token: string, target: TestWallet): Promise<SubmittedTransaction> => {
  const command = betCommand({ wallet: target });
  const response = await submitViaApi(app.baseUrl, token, command);
  expect(response.status).toBe(200);
  const body = await jsonOf(response);
  expect(body).toMatchObject({ status: 'PROCESSED' });
  return {
    id: String(body.transactionId),
    externalTransactionId: command.body.externalTransactionId,
  };
};

const routes: readonly RouteCase[] = [
  {
    name: 'POST /wallets',
    allowed: ['operator'],
    successStatus: 201,
    build: () => ({ method: 'POST', path: '/wallets', body: walletRequest() }),
  },
  {
    name: 'GET /wallets/:walletId',
    allowed: ['provider', 'operator'],
    successStatus: 200,
    build: () => ({ method: 'GET', path: `/wallets/${wallet.id}` }),
  },
  {
    name: 'GET /wallets/:walletId/ledger',
    allowed: ['operator'],
    successStatus: 200,
    build: () => ({ method: 'GET', path: `/wallets/${wallet.id}/ledger` }),
  },
  {
    name: 'POST /wagering/transactions',
    allowed: ['provider'],
    successStatus: 200,
    build: () => {
      const command = betCommand({ wallet });
      return {
        method: 'POST',
        path: '/wagering/transactions',
        body: command.body,
        headers: { 'Idempotency-Key': command.idempotencyKey },
      };
    },
  },
  {
    name: 'GET /wagering/transactions/:transactionId',
    allowed: ['provider', 'operator'],
    successStatus: 200,
    build: () => ({ method: 'GET', path: `/wagering/transactions/${transaction.id}` }),
  },
  {
    name: 'GET /providers/:providerId/wagering/transactions/:externalTransactionId',
    allowed: ['provider', 'operator'],
    successStatus: 200,
    build: () => ({
      method: 'GET',
      path: `/providers/${TEST_PROVIDER_ID}/wagering/transactions/${transaction.externalTransactionId}`,
    }),
  },
  {
    name: 'POST /wallets/:walletId/reconciliation',
    allowed: ['operator'],
    successStatus: 200,
    build: () => ({ method: 'POST', path: `/wallets/${wallet.id}/reconciliation` }),
  },
];

const ROLES: readonly Role[] = ['provider', 'operator'];

const expectProblem = async (
  response: Response,
  status: number,
  failureCode: string,
): Promise<void> => {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toStartWith(PROBLEM_CONTENT_TYPE);
  expect(await jsonOf(response)).toMatchObject({ status, failureCode });
};

const expectUnauthenticated = async (response: Response): Promise<void> => {
  expect(response.headers.get('www-authenticate')).toBe('Bearer');
  await expectProblem(response, 401, 'UNAUTHENTICATED');
};

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ roles: ['api'], env: { DATABASE_URL: database.appUrl } });
  operatorToken = await app.issuer.token({ role: 'operator' });
  providerToken = await app.issuer.token({ role: 'provider', providerId: TEST_PROVIDER_ID });
  otherProviderToken = await app.issuer.token({ role: 'provider', providerId: OTHER_PROVIDER_ID });
  wallet = await createWalletViaApi(app.baseUrl, operatorToken);
  transaction = await submitBet(providerToken, wallet);
});

afterAll(async () => {
  await app.stop();
});

describe('route authorization matrix', () => {
  for (const route of routes) {
    for (const role of ROLES) {
      if (route.allowed.includes(role)) {
        it(`accepts the ${role} role on ${route.name}`, async () => {
          const response = await send(app.baseUrl, route.build(), bearer(tokenFor(role)));

          expect(response.status).toBe(route.successStatus);
        });
      } else {
        it(`answers 403 FORBIDDEN to the ${role} role on ${route.name} without writing`, async () => {
          const before = await tableTotals();

          const response = await send(app.baseUrl, route.build(), bearer(tokenFor(role)));

          await expectProblem(response, 403, 'FORBIDDEN');
          expect(await tableTotals()).toEqual(before);
        });
      }
    }

    it(`answers 403 FORBIDDEN to a token without roles on ${route.name}`, async () => {
      const before = await tableTotals();

      const response = await send(app.baseUrl, route.build(), bearer(await app.issuer.noRoles()));

      await expectProblem(response, 403, 'FORBIDDEN');
      expect(await tableTotals()).toEqual(before);
    });

    it(`answers 401 with WWW-Authenticate when ${route.name} has no token`, async () => {
      const before = await tableTotals();

      const response = await send(app.baseUrl, route.build(), undefined);

      await expectUnauthenticated(response);
      expect(await tableTotals()).toEqual(before);
    });
  }
});

describe('token rejection', () => {
  const walletRoute = (): RouteRequest => ({ method: 'GET', path: `/wallets/${wallet.id}` });

  const invalidTokens: readonly (readonly [string, () => Promise<string>])[] = [
    ['an expired token', () => app.issuer.expired()],
    ['a token from another issuer', () => app.issuer.wrongIssuer()],
    ['a token for another audience', () => app.issuer.wrongAudience()],
    ['a token signed by another key', () => app.issuer.wrongSignature()],
  ];

  for (const [label, mint] of invalidTokens) {
    it(`answers 401 with WWW-Authenticate to ${label}`, async () => {
      const response = await send(app.baseUrl, walletRoute(), bearer(await mint()));

      await expectUnauthenticated(response);
    });
  }

  const malformedHeaders: readonly (readonly [string, () => string])[] = [
    ['a non-bearer scheme', () => `Basic ${operatorToken}`],
    ['a bearer header without a token', () => 'Bearer '],
    ['a token that is not a jwt', () => bearer('not-a-jwt')],
  ];

  for (const [label, header] of malformedHeaders) {
    it(`answers 401 with WWW-Authenticate to ${label}`, async () => {
      const response = await send(app.baseUrl, walletRoute(), header());

      await expectUnauthenticated(response);
    });
  }

  it('answers 403 FORBIDDEN to a provider token without provider_id', async () => {
    const response = await send(
      app.baseUrl,
      walletRoute(),
      bearer(await app.issuer.providerWithoutProviderId()),
    );

    await expectProblem(response, 403, 'FORBIDDEN');
  });
});

describe('provider isolation', () => {
  it('answers 404 when another provider reads a transaction by id', async () => {
    const response = await send(
      app.baseUrl,
      { method: 'GET', path: `/wagering/transactions/${transaction.id}` },
      bearer(otherProviderToken),
    );

    await expectProblem(response, 404, 'NOT_FOUND');
  });

  it('answers 404 when another provider reads a transaction by external id', async () => {
    const paths = [
      `/providers/${TEST_PROVIDER_ID}/wagering/transactions/${transaction.externalTransactionId}`,
      `/providers/${OTHER_PROVIDER_ID}/wagering/transactions/${transaction.externalTransactionId}`,
    ];

    for (const path of paths) {
      const response = await send(app.baseUrl, { method: 'GET', path }, bearer(otherProviderToken));

      await expectProblem(response, 404, 'NOT_FOUND');
    }
  });

  it('returns the transaction to its own provider and to an operator', async () => {
    for (const token of [providerToken, operatorToken]) {
      const response = await send(
        app.baseUrl,
        { method: 'GET', path: `/wagering/transactions/${transaction.id}` },
        bearer(token),
      );

      expect(response.status).toBe(200);
      expect(await jsonOf(response)).toMatchObject({
        id: transaction.id,
        providerId: TEST_PROVIDER_ID,
        externalTransactionId: transaction.externalTransactionId,
      });
    }
  });

  it('answers 403 PROVIDER_IDENTITY_MISMATCH and writes nothing when the body names another provider', async () => {
    const target = await createWalletViaApi(app.baseUrl, operatorToken);
    const command = betCommand({ wallet: target, providerId: OTHER_PROVIDER_ID });
    const before = await tableTotals();

    const response = await submitViaApi(app.baseUrl, providerToken, command);

    await expectProblem(response, 403, 'PROVIDER_IDENTITY_MISMATCH');
    expect(await tableTotals()).toEqual(before);
    expect(await walletState(target.id)).toEqual([{ balance: '1000.00', version: 1 }]);
    expect(
      await queryRows('select id from wager_transactions where external_transaction_id = $1', [
        command.body.externalTransactionId,
      ]),
    ).toEqual([]);
    expect(
      await queryRows('select provider_id from idempotency_records where idempotency_key = $1', [
        command.idempotencyKey,
      ]),
    ).toEqual([]);
  });
});

describe('public endpoints', () => {
  const publicPaths = ['/health/live', '/health/ready', '/metrics'];

  for (const path of publicPaths) {
    it(`serves ${path} without a token`, async () => {
      const response = await send(app.baseUrl, { method: 'GET', path }, undefined);

      expect(response.status).toBe(200);
    });

    it(`serves ${path} even with an invalid token`, async () => {
      const response = await send(app.baseUrl, { method: 'GET', path }, bearer('not-a-jwt'));

      expect(response.status).toBe(200);
    });
  }
});

describe('identity provider unreachable', () => {
  let unreachableApp: TestApp;

  const closedPortUrl = async (): Promise<string> => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
    const port = server.port;
    await server.stop(true);
    return `http://127.0.0.1:${String(port)}/certs`;
  };

  beforeAll(async () => {
    unreachableApp = await createTestApp({
      roles: ['api'],
      env: { DATABASE_URL: database.appUrl, AUTH_JWKS_URL: await closedPortUrl() },
    });
  });

  afterAll(async () => {
    await unreachableApp.stop();
  });

  it('answers 503 with Retry-After when the JWKS cannot be fetched', async () => {
    const token = await unreachableApp.issuer.token({ role: 'operator' });

    const response = await send(
      unreachableApp.baseUrl,
      { method: 'GET', path: `/wallets/${wallet.id}` },
      bearer(token),
    );

    expect(response.headers.get('retry-after')).toBe(CONNECTIVITY_RETRY_AFTER);
    await expectProblem(response, 503, 'INFRASTRUCTURE_UNAVAILABLE');
  });

  it('answers 503 to a submission and writes nothing when the JWKS cannot be fetched', async () => {
    const token = await unreachableApp.issuer.token({
      role: 'provider',
      providerId: TEST_PROVIDER_ID,
    });
    const command = betCommand({ wallet });
    const before = await tableTotals();

    const response = await submitViaApi(unreachableApp.baseUrl, token, command);

    expect(response.headers.get('retry-after')).toBe(CONNECTIVITY_RETRY_AFTER);
    await expectProblem(response, 503, 'INFRASTRUCTURE_UNAVAILABLE');
    expect(await tableTotals()).toEqual(before);
  });

  it('keeps health public while the JWKS is unreachable', async () => {
    const response = await send(
      unreachableApp.baseUrl,
      { method: 'GET', path: '/health/live' },
      undefined,
    );

    expect(response.status).toBe(200);
  });
});
