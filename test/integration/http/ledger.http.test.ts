import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { betCommand, createWalletViaApi, toMessageData } from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import { buildEnvelope, publishEnvelope } from '@test/support/sqs';
import { createTestApp } from '@test/support/test-app';
import type { TestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import { waitFor } from '@test/support/wait-for';

const PROBLEM_CONTENT_TYPE = 'application/problem+json';
const UNKNOWN_WALLET_ID = '0196c000-0000-7000-8000-0000000000fe';
const SEEDED_ENTRIES = 120;
const PAGE_SIZE = 50;
const BET_AMOUNT = '1.00';
const SETTLE_WAIT = { timeoutMs: 90_000, intervalMs: 200 } as const;

type Json = Record<string, unknown>;

interface LedgerEntry {
  readonly id: string;
  readonly walletVersion: number;
}

interface LedgerPage {
  readonly walletId: string;
  readonly entries: readonly LedgerEntry[];
  readonly nextCursor: string | null;
}

const isJson = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

class UnexpectedBodyError extends Error {
  constructor(body: unknown) {
    super(`unexpected body ${JSON.stringify(body)}`);
    this.name = 'UnexpectedBodyError';
  }
}

const toEntry = (value: unknown): LedgerEntry => {
  if (!isJson(value) || typeof value.id !== 'string' || typeof value.walletVersion !== 'number') {
    throw new UnexpectedBodyError(value);
  }
  return { id: value.id, walletVersion: value.walletVersion };
};

const toPage = (value: unknown): LedgerPage => {
  if (
    !isJson(value) ||
    typeof value.walletId !== 'string' ||
    !Array.isArray(value.entries) ||
    !(typeof value.nextCursor === 'string' || value.nextCursor === null)
  ) {
    throw new UnexpectedBodyError(value);
  }
  return {
    walletId: value.walletId,
    entries: value.entries.map(toEntry),
    nextCursor: value.nextCursor,
  };
};

const descendingVersions = (from: number, to: number): number[] =>
  Array.from({ length: from - to + 1 }, (_, index) => from - index);

let app: TestApp;
let operatorToken: string;

const ledgerResponse = (walletId: string, query: string): Promise<Response> =>
  fetch(`${app.baseUrl}/wallets/${walletId}/ledger${query}`, {
    headers: { Authorization: `Bearer ${operatorToken}` },
  });

const fetchPage = async (walletId: string, cursor: string | null): Promise<LedgerPage> => {
  const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
  const response = await ledgerResponse(walletId, query);
  expect(response.status).toBe(200);
  return toPage(await response.json());
};

const walletVersion = async (walletId: string): Promise<unknown> => {
  const response = await fetch(`${app.baseUrl}/wallets/${walletId}`, {
    headers: { Authorization: `Bearer ${operatorToken}` },
  });
  const body: unknown = await response.json();
  return isJson(body) ? body.version : undefined;
};

const publishBets = async (wallet: TestWallet, count: number): Promise<void> => {
  for (let index = 0; index < count; index += 1) {
    const bet = betCommand({ wallet, amount: BET_AMOUNT });
    await publishEnvelope(
      app.sqs,
      app.queueUrls.wagerTransactions,
      buildEnvelope({ data: toMessageData(bet) }),
    );
  }
};

const settleAt = (walletId: string, version: number): Promise<void> =>
  waitFor(async () => (await walletVersion(walletId)) === version, SETTLE_WAIT);

beforeAll(async () => {
  const database = await createTestDatabase();
  app = await createTestApp({
    roles: ['api', 'consumer'],
    env: { DATABASE_URL: database.appUrl },
  });
  operatorToken = await app.issuer.token({ role: 'operator' });
});

afterAll(async () => {
  await app.stop();
});

describe('GET /wallets/:walletId/ledger', () => {
  it('pages 120 entries in three pages with a cursor that survives a new entry', async () => {
    const wallet = await createWalletViaApi(app.baseUrl, operatorToken);
    await publishBets(wallet, SEEDED_ENTRIES - 1);
    await settleAt(wallet.id, SEEDED_ENTRIES);

    const first = await fetchPage(wallet.id, null);
    expect(first.walletId).toBe(wallet.id);
    expect(first.entries.map((entry) => entry.walletVersion)).toEqual(
      descendingVersions(SEEDED_ENTRIES, SEEDED_ENTRIES - PAGE_SIZE + 1),
    );
    expect(first.nextCursor).not.toBeNull();

    await publishBets(wallet, 1);
    await settleAt(wallet.id, SEEDED_ENTRIES + 1);

    const second = await fetchPage(wallet.id, first.nextCursor);
    expect(second.entries.map((entry) => entry.walletVersion)).toEqual(
      descendingVersions(SEEDED_ENTRIES - PAGE_SIZE, SEEDED_ENTRIES - 2 * PAGE_SIZE + 1),
    );
    expect(second.nextCursor).not.toBeNull();

    const third = await fetchPage(wallet.id, second.nextCursor);
    expect(third.entries.map((entry) => entry.walletVersion)).toEqual(
      descendingVersions(SEEDED_ENTRIES - 2 * PAGE_SIZE, 1),
    );
    expect(third.nextCursor).toBeNull();

    const pagedIds = [...first.entries, ...second.entries, ...third.entries].map(
      (entry) => entry.id,
    );
    expect(new Set(pagedIds).size).toBe(SEEDED_ENTRIES);

    const fresh = await fetchPage(wallet.id, null);
    const [newest] = fresh.entries;
    expect(newest?.walletVersion).toBe(SEEDED_ENTRIES + 1);
    expect(pagedIds).not.toContain(newest?.id);
    expect(fresh.entries.slice(1).map((entry) => entry.id)).toEqual(
      first.entries.slice(0, PAGE_SIZE - 1).map((entry) => entry.id),
    );
  });

  it('answers 400 INVALID_PAYLOAD for an invalid cursor', async () => {
    const wallet = await createWalletViaApi(app.baseUrl, operatorToken);
    const forged = Buffer.from(JSON.stringify({ v: 'x' }), 'utf8').toString('base64url');

    for (const cursor of ['not-a-cursor', forged, '%%%']) {
      const response = await ledgerResponse(wallet.id, `?cursor=${encodeURIComponent(cursor)}`);

      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toStartWith(PROBLEM_CONTENT_TYPE);
      expect(await response.json()).toMatchObject({ status: 400, failureCode: 'INVALID_PAYLOAD' });
    }
  });

  it('answers 404 NOT_FOUND for an unknown wallet', async () => {
    const response = await ledgerResponse(UNKNOWN_WALLET_ID, '');

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toStartWith(PROBLEM_CONTENT_TYPE);
    expect(await response.json()).toMatchObject({ status: 404, failureCode: 'NOT_FOUND' });
  });
});
