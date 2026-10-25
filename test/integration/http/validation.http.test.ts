import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createWalletViaApi, betCommand, refundCommand } from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import { createTestApp } from '@test/support/test-app';
import type { TestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID } from '@test/support/test-issuer';

const PROBLEM_CONTENT_TYPE = 'application/problem+json';
const OVERSIZED_LENGTH = 17 * 1024;

type Json = Record<string, unknown>;

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
let wallet: TestWallet;

interface PostOptions {
  readonly body: string;
  readonly contentType?: string | null;
  readonly idempotencyKey?: string | null;
}

const postTransactionRaw = (options: PostOptions): Promise<Response> => {
  const contentType = options.contentType === undefined ? 'application/json' : options.contentType;
  const idempotencyKey =
    options.idempotencyKey === undefined ? `idem-${crypto.randomUUID()}` : options.idempotencyKey;
  return fetch(`${app.baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${providerToken}`,
      ...(contentType === null ? {} : { 'Content-Type': contentType }),
      ...(idempotencyKey === null ? {} : { 'Idempotency-Key': idempotencyKey }),
    },
    body: options.body,
  });
};

const validBody = (): Json => ({ ...betCommand({ wallet }).body });

const postTransaction = (body: unknown, idempotencyKey?: string | null): Promise<Response> =>
  postTransactionRaw({
    body: JSON.stringify(body),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  });

const withoutField = (body: Json, field: string): Json =>
  Object.fromEntries(Object.entries(body).filter(([key]) => key !== field));

const postWalletRaw = (body: string, contentType: string | null = 'application/json') =>
  fetch(`${app.baseUrl}/wallets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${operatorToken}`,
      ...(contentType === null ? {} : { 'Content-Type': contentType }),
    },
    body,
  });

const postWallet = (body: unknown): Promise<Response> => postWalletRaw(JSON.stringify(body));

const expectProblem = async (
  response: Response,
  status: number,
  failureCode: string,
): Promise<Json> => {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain(PROBLEM_CONTENT_TYPE);
  const body = await jsonOf(response);
  expect(body.status).toBe(status);
  expect(body.failureCode).toBe(failureCode);
  return body;
};

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ roles: ['api'], env: { DATABASE_URL: database.appUrl } });
  operatorToken = await app.issuer.token({ role: 'operator' });
  providerToken = await app.issuer.token({ role: 'provider', providerId: TEST_PROVIDER_ID });
  wallet = await createWalletViaApi(app.baseUrl, operatorToken);
});

afterAll(async () => {
  await app.stop();
});

describe('POST /wagering/transactions validation', () => {
  it('accepts a valid body as the baseline', async () => {
    const response = await postTransaction(validBody());
    expect(response.status).toBe(200);
  });

  it('rejects a missing Idempotency-Key', async () => {
    const response = await postTransaction(validBody(), null);
    await expectProblem(response, 400, 'MISSING_IDEMPOTENCY_KEY');
  });

  it('rejects an Idempotency-Key longer than 255 characters', async () => {
    const response = await postTransaction(validBody(), 'k'.repeat(256));
    await expectProblem(response, 400, 'MISSING_IDEMPOTENCY_KEY');
  });

  it('rejects an Idempotency-Key with a non printable character', async () => {
    const response = await postTransaction(validBody(), 'key with space');
    await expectProblem(response, 400, 'MISSING_IDEMPOTENCY_KEY');
  });

  it('accepts an Idempotency-Key of 255 printable characters', async () => {
    const response = await postTransaction(validBody(), 'k'.repeat(255));
    expect(response.status).toBe(200);
  });

  it('prefers MISSING_IDEMPOTENCY_KEY over every other problem', async () => {
    const response = await postTransaction({ ...validBody(), kind: 'OPENING', extra: 1 }, null);
    const body = await expectProblem(response, 400, 'MISSING_IDEMPOTENCY_KEY');
    expect(Array.isArray(body.errors)).toBe(true);
  });

  it('rejects OPENING as UNSUPPORTED_KIND', async () => {
    const response = await postTransaction({ ...validBody(), kind: 'OPENING' });
    await expectProblem(response, 400, 'UNSUPPORTED_KIND');
  });

  it('rejects an unknown kind as UNSUPPORTED_KIND', async () => {
    const response = await postTransaction({ ...validBody(), kind: 'DEPOSIT' });
    await expectProblem(response, 400, 'UNSUPPORTED_KIND');
  });

  it('rejects a missing kind as UNSUPPORTED_KIND', async () => {
    const response = await postTransaction(withoutField(validBody(), 'kind'));
    await expectProblem(response, 400, 'UNSUPPORTED_KIND');
  });

  it('prefers UNSUPPORTED_KIND over invalid money and extra fields', async () => {
    const response = await postTransaction({
      ...validBody(),
      kind: 'OPENING',
      money: { amount: 10, currency: 'BRL' },
      extra: true,
    });
    await expectProblem(response, 400, 'UNSUPPORTED_KIND');
  });

  it('rejects a numeric amount as INVALID_MONEY', async () => {
    const response = await postTransaction({
      ...validBody(),
      money: { amount: 10, currency: 'BRL' },
    });
    await expectProblem(response, 400, 'INVALID_MONEY');
  });

  it('rejects an amount without two decimals as INVALID_MONEY', async () => {
    const response = await postTransaction({
      ...validBody(),
      money: { amount: '10.5', currency: 'BRL' },
    });
    await expectProblem(response, 400, 'INVALID_MONEY');
  });

  it('rejects a negative amount as INVALID_MONEY', async () => {
    const response = await postTransaction({
      ...validBody(),
      money: { amount: '-1.00', currency: 'BRL' },
    });
    await expectProblem(response, 400, 'INVALID_MONEY');
  });

  it('rejects a null amount as INVALID_MONEY', async () => {
    const response = await postTransaction({
      ...validBody(),
      money: { amount: null, currency: 'BRL' },
    });
    await expectProblem(response, 400, 'INVALID_MONEY');
  });

  it('rejects a malformed currency as INVALID_MONEY', async () => {
    const response = await postTransaction({
      ...validBody(),
      money: { amount: '10.00', currency: 'brl' },
    });
    await expectProblem(response, 400, 'INVALID_MONEY');
  });

  it('prefers INVALID_MONEY over an unsupported currency elsewhere', async () => {
    const response = await postTransaction({
      ...validBody(),
      money: { amount: 10, currency: 'XXX' },
    });
    await expectProblem(response, 400, 'INVALID_MONEY');
  });

  it('rejects a well formed but unsupported currency as UNSUPPORTED_CURRENCY', async () => {
    const response = await postTransaction({
      ...validBody(),
      money: { amount: '10.00', currency: 'XXX' },
    });
    await expectProblem(response, 400, 'UNSUPPORTED_CURRENCY');
  });

  it('rejects a zero BET as INVALID_AMOUNT', async () => {
    const response = await postTransaction({
      ...validBody(),
      money: { amount: '0.00', currency: 'BRL' },
    });
    await expectProblem(response, 400, 'INVALID_AMOUNT');
  });

  it('accepts a zero LOSS', async () => {
    const response = await postTransaction({
      ...validBody(),
      kind: 'LOSS',
      money: { amount: '0.00', currency: 'BRL' },
    });
    expect(response.status).toBe(200);
  });

  it('rejects a REFUND without reference as REFERENCE_REQUIRED', async () => {
    const response = await postTransaction({ ...validBody(), kind: 'REFUND' });
    await expectProblem(response, 400, 'REFERENCE_REQUIRED');
  });

  it('rejects a ROLLBACK without reference as REFERENCE_REQUIRED', async () => {
    const response = await postTransaction({ ...validBody(), kind: 'ROLLBACK' });
    await expectProblem(response, 400, 'REFERENCE_REQUIRED');
  });

  it('prefers INVALID_AMOUNT over REFERENCE_REQUIRED', async () => {
    const response = await postTransaction({
      ...validBody(),
      kind: 'REFUND',
      money: { amount: '0.00', currency: 'BRL' },
    });
    await expectProblem(response, 400, 'INVALID_AMOUNT');
  });

  it('rejects a reference on a BET as INVALID_PAYLOAD', async () => {
    const response = await postTransaction({
      ...validBody(),
      referenceExternalTransactionId: 'other-ext',
    });
    await expectProblem(response, 400, 'INVALID_PAYLOAD');
  });

  it('rejects a self reference as INVALID_PAYLOAD', async () => {
    const command = refundCommand({ wallet, referenceExternalTransactionId: 'same-id' });
    const response = await postTransaction({
      ...command.body,
      externalTransactionId: 'same-id',
    });
    await expectProblem(response, 400, 'INVALID_PAYLOAD');
  });

  it('rejects an extra field as INVALID_PAYLOAD', async () => {
    const response = await postTransaction({ ...validBody(), surprise: 'x' });
    await expectProblem(response, 400, 'INVALID_PAYLOAD');
  });

  it('rejects an extra field inside money as INVALID_PAYLOAD', async () => {
    const response = await postTransaction({
      ...validBody(),
      money: { amount: '10.00', currency: 'BRL', extra: 1 },
    });
    await expectProblem(response, 400, 'INVALID_PAYLOAD');
  });

  it('rejects a null field as INVALID_PAYLOAD', async () => {
    const response = await postTransaction({ ...validBody(), roundId: null });
    await expectProblem(response, 400, 'INVALID_PAYLOAD');
  });

  it('rejects a null optional field as INVALID_PAYLOAD', async () => {
    const response = await postTransaction({
      ...validBody(),
      referenceExternalTransactionId: null,
    });
    await expectProblem(response, 400, 'INVALID_PAYLOAD');
  });

  it('rejects the reserved __system__ provider id as INVALID_PAYLOAD', async () => {
    const response = await postTransaction({ ...validBody(), providerId: '__system__' });
    await expectProblem(response, 400, 'INVALID_PAYLOAD');
  });

  it('rejects a non UUID walletId as INVALID_PAYLOAD', async () => {
    const response = await postTransaction({ ...validBody(), walletId: 'not-a-uuid' });
    await expectProblem(response, 400, 'INVALID_PAYLOAD');
  });

  it('rejects an externalTransactionId with whitespace as INVALID_PAYLOAD', async () => {
    const response = await postTransaction({ ...validBody(), externalTransactionId: 'a b' });
    await expectProblem(response, 400, 'INVALID_PAYLOAD');
  });

  it('lists every problem in errors with path and message', async () => {
    const response = await postTransaction({ ...validBody(), roundId: null, surprise: 1 });
    const body = await expectProblem(response, 400, 'INVALID_PAYLOAD');
    const errors = body.errors;
    expect(Array.isArray(errors)).toBe(true);
    if (!Array.isArray(errors)) {
      return;
    }
    const list: unknown[] = errors;
    expect(list.length).toBeGreaterThanOrEqual(2);
    for (const entry of list) {
      expect(isJson(entry)).toBe(true);
      expect(isJson(entry) && typeof entry.path === 'string').toBe(true);
      expect(isJson(entry) && typeof entry.message === 'string').toBe(true);
    }
  });
});

describe('request body envelope', () => {
  it('rejects malformed JSON as INVALID_PAYLOAD', async () => {
    const response = await postTransactionRaw({ body: '{"providerId": ' });
    await expectProblem(response, 400, 'INVALID_PAYLOAD');
  });

  it('rejects malformed JSON on POST /wallets as INVALID_PAYLOAD', async () => {
    const response = await postWalletRaw('{not json');
    await expectProblem(response, 400, 'INVALID_PAYLOAD');
  });

  it('rejects a body above 16 kb as INVALID_PAYLOAD', async () => {
    const response = await postTransaction({
      ...validBody(),
      roundId: 'r'.repeat(OVERSIZED_LENGTH),
    });
    await expectProblem(response, 400, 'INVALID_PAYLOAD');
  });

  it('rejects a body above 16 kb on POST /wallets as INVALID_PAYLOAD', async () => {
    const response = await postWallet({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '1.00', currency: 'BRL' },
      padding: 'p'.repeat(OVERSIZED_LENGTH),
    });
    await expectProblem(response, 400, 'INVALID_PAYLOAD');
  });

  it('rejects text/plain with a valid JSON body as INVALID_PAYLOAD', async () => {
    const response = await postTransactionRaw({
      body: JSON.stringify(validBody()),
      contentType: 'text/plain',
    });
    await expectProblem(response, 400, 'INVALID_PAYLOAD');
  });

  it('rejects text/plain on POST /wallets as INVALID_PAYLOAD', async () => {
    const response = await postWalletRaw(
      JSON.stringify({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '1.00', currency: 'BRL' },
      }),
      'text/plain',
    );
    await expectProblem(response, 400, 'INVALID_PAYLOAD');
  });

  it('rejects a missing Content-Type with a body as INVALID_PAYLOAD', async () => {
    const response = await postTransactionRaw({
      body: JSON.stringify(validBody()),
      contentType: null,
    });
    await expectProblem(response, 400, 'INVALID_PAYLOAD');
  });

  it('rejects an empty body without Content-Type as INVALID_PAYLOAD', async () => {
    const response = await postTransactionRaw({ body: '', contentType: null });
    await expectProblem(response, 400, 'INVALID_PAYLOAD');
  });

  it('rejects an empty JSON body as a 400 problem', async () => {
    const response = await postTransactionRaw({ body: '' });
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain(PROBLEM_CONTENT_TYPE);
  });
});

describe('POST /wallets validation', () => {
  const validWallet = (): Json => ({
    playerId: crypto.randomUUID(),
    initialBalance: { amount: '5.00', currency: 'BRL' },
  });

  it('accepts a zero initial balance', async () => {
    const response = await postWallet({
      ...validWallet(),
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });
    expect(response.status).toBe(201);
  });

  it('rejects a non UUID playerId as INVALID_PAYLOAD', async () => {
    const response = await postWallet({ ...validWallet(), playerId: 'player-1' });
    await expectProblem(response, 400, 'INVALID_PAYLOAD');
  });

  it('rejects a missing playerId as INVALID_PAYLOAD', async () => {
    const response = await postWallet({ initialBalance: { amount: '5.00', currency: 'BRL' } });
    await expectProblem(response, 400, 'INVALID_PAYLOAD');
  });

  it('rejects a numeric initial amount as INVALID_MONEY', async () => {
    const response = await postWallet({
      ...validWallet(),
      initialBalance: { amount: 5, currency: 'BRL' },
    });
    await expectProblem(response, 400, 'INVALID_MONEY');
  });

  it('rejects a null initial balance as INVALID_PAYLOAD', async () => {
    const response = await postWallet({ ...validWallet(), initialBalance: null });
    await expectProblem(response, 400, 'INVALID_PAYLOAD');
  });

  it('rejects an unsupported currency as UNSUPPORTED_CURRENCY', async () => {
    const response = await postWallet({
      ...validWallet(),
      initialBalance: { amount: '5.00', currency: 'XXX' },
    });
    await expectProblem(response, 400, 'UNSUPPORTED_CURRENCY');
  });

  it('rejects an extra field as INVALID_PAYLOAD', async () => {
    const response = await postWallet({ ...validWallet(), role: 'admin' });
    await expectProblem(response, 400, 'INVALID_PAYLOAD');
  });

  it('rejects a non UUID walletId in the path as INVALID_PAYLOAD', async () => {
    const response = await fetch(`${app.baseUrl}/wallets/not-a-uuid`, {
      headers: { Authorization: `Bearer ${operatorToken}` },
    });
    await expectProblem(response, 400, 'INVALID_PAYLOAD');
  });
});
