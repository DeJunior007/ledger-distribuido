import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { encodeLedgerCursor } from '@interfaces/http/schemas/ledger-query.schema';
import { registerCurrentDatabase } from '@test/support/current-database';
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

const PROBLEM_CONTENT_TYPE = 'application/problem+json';
const CONCURRENT_CREATIONS = 10;

type Json = Readonly<Record<string, unknown>>;

interface LedgerPage {
  readonly walletId: unknown;
  readonly versions: readonly unknown[];
  readonly nextCursor: unknown;
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

let database: TestDatabase;
let app: TestApp;
let operatorToken: string;
let providerToken: string;

const ledgerResponse = (walletId: string, query: string): Promise<Response> =>
  fetch(`${app.baseUrl}/wallets/${walletId}/ledger${query}`, {
    headers: { Authorization: `Bearer ${operatorToken}` },
  });

const ledgerPage = async (walletId: string, query: string): Promise<LedgerPage> => {
  const response = await ledgerResponse(walletId, query);
  expect(response.status).toBe(200);
  const body = await jsonOf(response);
  const entries: unknown = body.entries;
  if (!Array.isArray(entries)) {
    throw new UnexpectedBodyError(body);
  }
  const list: unknown[] = entries;
  return {
    walletId: body.walletId,
    versions: list.map((entry) => (isJson(entry) ? entry.walletVersion : undefined)),
    nextCursor: body.nextCursor,
  };
};

const cursorQuery = (cursor: unknown): string => `&cursor=${encodeURIComponent(String(cursor))}`;

const walletWithEntries = async (bets: number): Promise<TestWallet> => {
  const wallet = await createWalletViaApi(app.baseUrl, operatorToken);
  for (let index = 0; index < bets; index += 1) {
    const response = await submitViaApi(app.baseUrl, providerToken, betCommand({ wallet }));
    expect(response.status).toBe(200);
  }
  return wallet;
};

const postWallet = (body: unknown): Promise<Response> =>
  fetch(`${app.baseUrl}/wallets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${operatorToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ roles: ['api'], env: { DATABASE_URL: database.appUrl } });
  operatorToken = await app.issuer.token({ role: 'operator' });
  providerToken = await app.issuer.token({ role: 'provider', providerId: TEST_PROVIDER_ID });
});

beforeEach(() => {
  registerCurrentDatabase(database.superuserUrl);
});

afterAll(async () => {
  await app.stop();
});

describe('GET /wallets/:walletId/ledger limit', () => {
  const invalidLimits: readonly string[] = [
    'limit=0',
    'limit=201',
    'limit=050',
    'limit=abc',
    'limit=1&limit=2',
  ];

  for (const query of invalidLimits) {
    it(`rejects ${query} as INVALID_PAYLOAD`, async () => {
      const wallet = await createWalletViaApi(app.baseUrl, operatorToken);
      const response = await ledgerResponse(wallet.id, `?${query}`);
      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toStartWith(PROBLEM_CONTENT_TYPE);
      expect(await jsonOf(response)).toMatchObject({ status: 400, failureCode: 'INVALID_PAYLOAD' });
    });
  }

  it('accepts the bounds 1 and 200', async () => {
    const wallet = await walletWithEntries(2);
    expect((await ledgerPage(wallet.id, '?limit=1')).versions).toEqual([3]);
    expect((await ledgerPage(wallet.id, '?limit=200')).versions).toEqual([3, 2, 1]);
  });
});

describe('GET /wallets/:walletId/ledger cursor', () => {
  it('applies a cursor of another wallet as a plain version position', async () => {
    const source = await walletWithEntries(3);
    const target = await walletWithEntries(1);
    const sourcePage = await ledgerPage(source.id, '?limit=1');
    expect(sourcePage.versions).toEqual([4]);
    expect(sourcePage.nextCursor).toBe(encodeLedgerCursor(4));

    const borrowed = await ledgerPage(target.id, `?limit=50${cursorQuery(sourcePage.nextCursor)}`);
    expect(borrowed.walletId).toBe(target.id);
    expect(borrowed.versions).toEqual([2, 1]);
    expect(borrowed.nextCursor).toBeNull();
  });

  it('ends with a null nextCursor on a full last page without an extra empty page', async () => {
    const wallet = await walletWithEntries(3);
    const first = await ledgerPage(wallet.id, '?limit=2');
    expect(first.versions).toEqual([4, 3]);
    expect(first.nextCursor).toBe(encodeLedgerCursor(3));

    const last = await ledgerPage(wallet.id, `?limit=2${cursorQuery(first.nextCursor)}`);
    expect(last.versions).toEqual([2, 1]);
    expect(last.nextCursor).toBeNull();
  });

  it('answers an empty page with a null nextCursor past the oldest entry', async () => {
    const wallet = await walletWithEntries(1);
    const page = await ledgerPage(wallet.id, `?limit=10${cursorQuery(encodeLedgerCursor(1))}`);
    expect(page.walletId).toBe(wallet.id);
    expect(page.versions).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});

describe('POST /wallets concurrency', () => {
  it('creates exactly one wallet for concurrent requests of the same player and currency', async () => {
    const request = walletRequest();
    const responses = await Promise.all(
      Array.from({ length: CONCURRENT_CREATIONS }, () => postWallet(request)),
    );
    const results = await Promise.all(
      responses.map(async (response) => ({
        status: response.status,
        body: await jsonOf(response),
      })),
    );

    const created = results.filter((result) => result.status === 201);
    const conflicts = results.filter((result) => result.status === 409);
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(CONCURRENT_CREATIONS - 1);
    const walletId = created[0]?.body.id;
    expect(typeof walletId).toBe('string');
    for (const conflict of conflicts) {
      expect(conflict.body).toMatchObject({
        status: 409,
        failureCode: 'WALLET_ALREADY_EXISTS',
        walletId,
      });
    }

    const page = await ledgerPage(String(walletId), '');
    expect(page.versions).toEqual([1]);
  });
});
