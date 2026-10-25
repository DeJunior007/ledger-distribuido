import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { createWalletViaApi, walletRequest } from '@test/support/fixtures';
import type { WalletRequest } from '@test/support/fixtures';
import { createTestApp } from '@test/support/test-app';
import type { TestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID } from '@test/support/test-issuer';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROBLEM_CONTENT_TYPE = 'application/problem+json';
const UNKNOWN_WALLET_ID = '0196c000-0000-7000-8000-0000000000ff';

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

const isoTimestamp = (value: unknown): boolean =>
  typeof value === 'string' && new Date(value).toISOString() === value;

let database: TestDatabase;
let app: TestApp;
let operatorToken: string;
let providerToken: string;

const postWallet = (request: WalletRequest): Promise<Response> =>
  fetch(`${app.baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${operatorToken}` },
    body: JSON.stringify(request),
  });

const getWallet = (walletId: string, token: string): Promise<Response> =>
  fetch(`${app.baseUrl}/wallets/${walletId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

const getLedger = async (walletId: string): Promise<Json> => {
  const response = await fetch(`${app.baseUrl}/wallets/${walletId}/ledger`, {
    headers: { Authorization: `Bearer ${operatorToken}` },
  });
  expect(response.status).toBe(200);
  return jsonOf(response);
};

const queryRows = async (sql: string, params: readonly unknown[]): Promise<Json[]> => {
  const client = new Client({ connectionString: database.superuserUrl });
  await client.connect();
  try {
    const result = await client.query<Json>(sql, [...params]);
    return result.rows;
  } finally {
    await client.end();
  }
};

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ roles: ['api'], env: { DATABASE_URL: database.appUrl } });
  operatorToken = await app.issuer.token({ role: 'operator' });
  providerToken = await app.issuer.token({ role: 'provider', providerId: TEST_PROVIDER_ID });
});

afterAll(async () => {
  await app.stop();
});

describe('POST /wallets', () => {
  it('creates a funded wallet with exactly four fields and an OPENING ledger entry', async () => {
    const request = walletRequest({ initialBalance: { amount: '1000.00', currency: 'BRL' } });

    const response = await postWallet(request);

    expect(response.status).toBe(201);
    const body = await jsonOf(response);
    expect(Object.keys(body).sort()).toEqual(['balance', 'id', 'playerId', 'version']);
    expect(body).toEqual({
      id: expect.stringMatching(UUID_V7),
      playerId: request.playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });

    const openingEntry: Json = {
      id: expect.stringMatching(UUID_V7),
      transactionId: expect.stringMatching(UUID_V7),
      direction: 'CREDIT',
      money: { amount: '1000.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '1000.00', currency: 'BRL' },
      walletVersion: 1,
      createdAt: expect.any(String),
    };
    const ledger = await getLedger(String(body.id));
    expect(ledger).toEqual({ walletId: body.id, entries: [openingEntry], nextCursor: null });
    const entries: unknown[] = Array.isArray(ledger.entries) ? ledger.entries : [];
    const [entry] = entries;
    const transactionId: unknown = isJson(entry) ? entry.transactionId : undefined;

    const transactions = await queryRows(
      'select kind, status, provider_id, wallet_id from wager_transactions where id = $1',
      [transactionId],
    );
    expect(transactions).toEqual([
      { kind: 'OPENING', status: 'PROCESSED', provider_id: '__system__', wallet_id: body.id },
    ]);
  });

  it('creates a wallet with a zero balance and an empty ledger', async () => {
    const request = walletRequest({ initialBalance: { amount: '0.00', currency: 'BRL' } });

    const response = await postWallet(request);

    expect(response.status).toBe(201);
    const body = await jsonOf(response);
    expect(Object.keys(body).sort()).toEqual(['balance', 'id', 'playerId', 'version']);
    expect(body).toEqual({
      id: expect.stringMatching(UUID_V7),
      playerId: request.playerId,
      balance: { amount: '0.00', currency: 'BRL' },
      version: 1,
    });

    expect(await getLedger(String(body.id))).toEqual({
      walletId: body.id,
      entries: [],
      nextCursor: null,
    });
    const transactions = await queryRows(
      'select count(*)::int as total from wager_transactions where wallet_id = $1',
      [body.id],
    );
    expect(transactions).toEqual([{ total: 0 }]);
  });

  it('answers 409 with the walletId of the existing wallet for the same player and currency', async () => {
    const existing = await createWalletViaApi(app.baseUrl, operatorToken);

    const response = await postWallet(
      walletRequest({
        playerId: existing.playerId,
        initialBalance: { amount: '50.00', currency: 'BRL' },
      }),
    );

    expect(response.status).toBe(409);
    expect(response.headers.get('content-type')).toStartWith(PROBLEM_CONTENT_TYPE);
    expect(await jsonOf(response)).toMatchObject({
      status: 409,
      failureCode: 'WALLET_ALREADY_EXISTS',
      walletId: existing.id,
    });
    const wallets = await queryRows(
      'select id, balance::text as balance from wallets where player_id = $1',
      [existing.playerId],
    );
    expect(wallets).toEqual([{ id: existing.id, balance: '1000.00' }]);
  });
});

describe('GET /wallets/:walletId', () => {
  it('returns the full wallet view to an operator', async () => {
    const wallet = await createWalletViaApi(app.baseUrl, operatorToken);

    const response = await getWallet(wallet.id, operatorToken);

    expect(response.status).toBe(200);
    const body = await jsonOf(response);
    expect(Object.keys(body).sort()).toEqual([
      'balance',
      'createdAt',
      'id',
      'playerId',
      'updatedAt',
      'version',
    ]);
    expect(body).toMatchObject({
      id: wallet.id,
      playerId: wallet.playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    expect(isoTimestamp(body.createdAt)).toBe(true);
    expect(isoTimestamp(body.updatedAt)).toBe(true);
  });

  it('returns only id, balance and version to a provider', async () => {
    const wallet = await createWalletViaApi(app.baseUrl, operatorToken);

    const response = await getWallet(wallet.id, providerToken);

    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toEqual({
      id: wallet.id,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
  });

  it('answers 404 NOT_FOUND for an unknown wallet to both roles', async () => {
    for (const token of [operatorToken, providerToken]) {
      const response = await getWallet(UNKNOWN_WALLET_ID, token);

      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toStartWith(PROBLEM_CONTENT_TYPE);
      expect(await jsonOf(response)).toMatchObject({ status: 404, failureCode: 'NOT_FOUND' });
    }
  });
});
