import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import {
  betCommand,
  createWalletViaApi,
  createWalletViaUseCase,
  rollbackCommand,
  submitViaApi,
} from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import type { WagerTransactionRequest } from '@interfaces/http/schemas/wager-transaction.schema';
import { registerCurrentDatabase } from '@test/support/current-database';
import { spawnInstances } from '@test/support/spawn-instances';
import type { SpawnedInstances } from '@test/support/spawn-instances';
import { countMessages } from '@test/support/sqs';
import { createTestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID, TestIssuer } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

type Json = Readonly<Record<string, unknown>>;

interface Outcome {
  readonly status: number;
  readonly body: Json;
}

const API_COUNT = 2;
const PARALLEL = 10;
const OUTBOX_WAIT = { timeoutMs: 20_000, intervalMs: 100 } as const;

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

const queryRows = async (
  url: string,
  sql: string,
  params: readonly unknown[] = [],
): Promise<Json[]> => {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<Json>(sql, [...params])).rows;
  } finally {
    await client.end();
  }
};

let database: TestDatabase;
let issuer: TestIssuer;
let apis: SpawnedInstances;
let providerToken: string;
let operatorToken: string;

const rows = (sql: string, params: readonly unknown[] = []): Promise<Json[]> =>
  queryRows(database.superuserUrl, sql, params);

const baseUrl = (index: number): string => apis.instance(index % API_COUNT).baseUrl;

const submit = async (request: WagerTransactionRequest, index = 0): Promise<Outcome> => {
  const response = await submitViaApi(baseUrl(index), providerToken, request);
  return { status: response.status, body: await jsonOf(response) };
};

const submitAll = (requests: readonly WagerTransactionRequest[]): Promise<Outcome[]> =>
  Promise.all(requests.map((request, index) => submit(request, index)));

const newWallet = (amount: string): Promise<TestWallet> =>
  createWalletViaApi(baseUrl(0), operatorToken, {
    initialBalance: { amount, currency: 'BRL' },
  });

const balanceOf = async (walletId: string): Promise<unknown> =>
  (await rows('SELECT balance::text AS balance FROM wallets WHERE id = $1', [walletId]))[0]
    ?.balance;

const walletEntries = (walletId: string): Promise<Json[]> =>
  rows(
    `SELECT direction, amount::text AS amount
       FROM wallet_ledger_entries
      WHERE wallet_id = $1
      ORDER BY wallet_version`,
    [walletId],
  );

const statuses = (outcomes: readonly Outcome[]): number[] =>
  outcomes.map((outcome) => outcome.status).sort((left, right) => left - right);

beforeAll(async () => {
  database = await createTestDatabase();
  const queues = await createTestQueues();
  issuer = await TestIssuer.start();
  apis = await spawnInstances({
    role: 'api',
    count: API_COUNT,
    env: { DATABASE_URL: database.appUrl, ...queues.env, ...issuer.authConfig },
  });
  providerToken = await issuer.token({ role: 'provider', providerId: TEST_PROVIDER_ID });
  operatorToken = await issuer.token({ role: 'operator' });
});

beforeEach(() => {
  registerCurrentDatabase(database.superuserUrl);
});

afterAll(async () => {
  await apis.stop();
  await issuer.stop();
});

describe('§14 falhas eliminatórias', () => {
  it('never lets a race drive the balance negative', async () => {
    const wallet = await newWallet('50.00');

    const outcomes = await submitAll(
      Array.from({ length: PARALLEL }, () => betCommand({ wallet, amount: '10.00' })),
    );

    expect(statuses(outcomes)).toEqual([200, 200, 200, 200, 200, 422, 422, 422, 422, 422]);
    for (const outcome of outcomes.filter((candidate) => candidate.status === 422)) {
      expect(outcome.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    }
    expect(await balanceOf(wallet.id)).toBe('0.00');
    expect(
      await rows(
        'SELECT count(*)::int AS negative FROM wallet_ledger_entries WHERE wallet_id = $1 AND balance_after < 0',
        [wallet.id],
      ),
    ).toEqual([{ negative: 0 }]);
  });

  it('never debits the same bet twice', async () => {
    const wallet = await newWallet('100.00');
    const bet = betCommand({ wallet, amount: '10.00' });

    const outcomes = await submitAll(Array.from({ length: PARALLEL }, () => bet));

    expect(statuses(outcomes)).toEqual(Array.from({ length: PARALLEL }, () => 200));
    expect(new Set(outcomes.map((outcome) => outcome.body.transactionId)).size).toBe(1);
    expect(await balanceOf(wallet.id)).toBe('90.00');
    expect(await walletEntries(wallet.id)).toEqual([
      { direction: 'CREDIT', amount: '100.00' },
      { direction: 'DEBIT', amount: '10.00' },
    ]);
  });

  it('never credits twice when two reversals of the same bet race', async () => {
    const wallet = await newWallet('100.00');
    const bet = betCommand({ wallet, amount: '10.00' });
    expect((await submit(bet)).status).toBe(200);
    const reference = bet.body.externalTransactionId;

    const outcomes = await submitAll(
      Array.from({ length: PARALLEL }, () =>
        rollbackCommand({
          wallet,
          amount: '10.00',
          roundId: bet.body.roundId,
          referenceExternalTransactionId: reference,
        }),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.status === 200)).toHaveLength(1);
    for (const outcome of outcomes.filter((candidate) => candidate.status !== 200)) {
      expect(outcome.status).toBe(422);
      expect(outcome.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    }
    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect(await walletEntries(wallet.id)).toEqual([
      { direction: 'CREDIT', amount: '100.00' },
      { direction: 'DEBIT', amount: '10.00' },
      { direction: 'CREDIT', amount: '10.00' },
    ]);
  });

  it('keeps idempotency after every api process is killed and restarted', async () => {
    const wallet = await newWallet('100.00');
    const bet = betCommand({ wallet, amount: '10.00' });
    const first = await submit(bet, 0);
    expect(first.status).toBe(200);

    await Promise.all(apis.instances.map((instance) => instance.restart()));
    const replay = await submit(bet, 1);

    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.transactionId).toBe(first.body.transactionId);
    expect(await balanceOf(wallet.id)).toBe('90.00');
    expect(
      await rows(
        'SELECT count(*)::int AS total FROM wager_transactions WHERE provider_id = $1 AND idempotency_key = $2',
        [TEST_PROVIDER_ID, bet.idempotencyKey],
      ),
    ).toEqual([{ total: 1 }]);
  });

  it('never publishes an event before its transaction commits', async () => {
    const outboxDatabase = await createTestDatabase();
    const app = await createTestApp({
      roles: ['outbox'],
      env: { DATABASE_URL: outboxDatabase.appUrl },
    });
    const writer = new Client({ connectionString: outboxDatabase.superuserUrl });
    await writer.connect();
    const pendingId = randomUUID();
    const published = async (): Promise<unknown[]> =>
      (
        await queryRows(
          outboxDatabase.superuserUrl,
          'SELECT id FROM outbox_messages WHERE published_at IS NOT NULL',
        )
      ).map((row) => row.id);
    try {
      await writer.query('BEGIN');
      await writer.query(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
         VALUES ($1, $2, 'WalletBalanceChanged', $3::jsonb, now(), now())`,
        [
          pendingId,
          pendingId,
          JSON.stringify({
            eventId: pendingId,
            eventType: 'WalletBalanceChanged',
            aggregateId: pendingId,
            correlationId: `corr-${pendingId}`,
            occurredAt: new Date().toISOString(),
            version: 1,
            data: { walletId: pendingId },
          }),
        ],
      );
      await createWalletViaUseCase(app);
      await waitFor(async () => (await published()).length === 2, OUTBOX_WAIT);

      expect(await published()).not.toContain(pendingId);
      expect((await countMessages(app.sqs, app.queueUrls.walletEvents)).total).toBe(2);

      await writer.query('COMMIT');
      await waitFor(async () => (await published()).includes(pendingId), OUTBOX_WAIT);
      expect((await countMessages(app.sqs, app.queueUrls.walletEvents)).total).toBe(3);
    } finally {
      await writer.end();
      await app.stop();
    }
  });

  it('keeps an auditable ledger that the reconciliation confirms', async () => {
    const wallet = await newWallet('100.00');
    expect((await submit(betCommand({ wallet, amount: '30.00' }))).status).toBe(200);

    const response = await fetch(`${baseUrl(1)}/wallets/${wallet.id}/reconciliation`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${operatorToken}` },
    });

    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toMatchObject({
      walletId: wallet.id,
      storedBalance: { amount: '70.00', currency: 'BRL' },
      calculatedBalance: { amount: '70.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
      chain: { valid: true, firstDivergentVersion: null, problems: [] },
    });
  });

  it('keeps one effect when the same key arrives with different payloads in parallel', async () => {
    const wallet = await newWallet('100.00');
    const idempotencyKey = `idem-${randomUUID()}`;

    const outcomes = await submitAll(
      Array.from({ length: PARALLEL }, (_, index) =>
        betCommand({ wallet, idempotencyKey, amount: `${String(index + 1)}.00` }),
      ),
    );

    const winners = outcomes.filter((outcome) => outcome.status === 200);
    expect(winners).toHaveLength(1);
    for (const outcome of outcomes.filter((candidate) => candidate.status !== 200)) {
      expect(outcome.status).toBe(409);
      expect(outcome.body.failureCode).toBe('IDEMPOTENCY_KEY_CONFLICT');
    }
    expect(await walletEntries(wallet.id)).toHaveLength(2);
    expect(
      await rows(
        'SELECT count(*)::int AS total FROM wager_transactions WHERE provider_id = $1 AND idempotency_key = $2',
        [TEST_PROVIDER_ID, idempotencyKey],
      ),
    ).toEqual([{ total: 1 }]);
  });
});
