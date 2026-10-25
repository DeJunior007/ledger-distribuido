import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import type { WagerTransactionRequest } from '@interfaces/http/schemas/wager-transaction.schema';
import {
  createWalletViaApi,
  submitViaApi,
  toMessageData,
  wagerCommand,
} from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import { spawnInstances } from '@test/support/spawn-instances';
import type { SpawnedInstance, SpawnedInstances } from '@test/support/spawn-instances';
import {
  buildEnvelope,
  countMessages,
  createTestSqsClient,
  publishEnvelope,
} from '@test/support/sqs';
import { createTestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID, TestIssuer } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

const API_COUNT = 3;
const CONSUMER_COUNT = 2;
const HTTP_OPERATIONS = 60;
const QUEUE_OPERATIONS = 40;
const MIN_RECONCILIATIONS_PER_LOOP = 5;
const WALLET_CREATIONS_PER_API = 10;
const TRANSIENT_STATUS = 503;
const MAX_ATTEMPTS = 10;
const RETRY_BACKOFF_MS = 200;
const SETTLE_WAIT = { timeoutMs: 120_000, intervalMs: 250 } as const;
const MISMATCH_METRIC = 'jungle_reconciliation_mismatch_total';
const RUNS_METRIC = 'jungle_reconciliation_runs_total';
const METRIC_LINE = /^([a-z_]+)(?:\{([^}]*)\})?\s+(\S+)$/;

type Json = Record<string, unknown>;

interface Answer {
  readonly status: number;
  readonly body: Json;
}

interface ReconciliationSample {
  readonly loop: number;
  readonly body: Json;
}

const queryRows = async (
  databaseUrl: string,
  sql: string,
  params: readonly unknown[] = [],
): Promise<Json[]> => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<Json>(sql, [...params]);
    return result.rows;
  } finally {
    await client.end();
  }
};

const readAnswer = async (response: Response): Promise<Answer> => {
  const parsed: unknown = await response.json();
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`unexpected body: ${JSON.stringify(parsed)}`);
  }
  return { status: response.status, body: { ...parsed } };
};

const withRetry = async (send: () => Promise<Response>): Promise<Answer> => {
  for (let attempt = 1; ; attempt += 1) {
    const answer = await readAnswer(await send());
    if (answer.status !== TRANSIENT_STATUS || attempt >= MAX_ATTEMPTS) {
      return answer;
    }
    await Bun.sleep(RETRY_BACKOFF_MS * attempt);
  }
};

const reconcile = (baseUrl: string, operatorToken: string, walletId: string): Promise<Answer> =>
  withRetry(() =>
    fetch(`${baseUrl}/wallets/${walletId}/reconciliation`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${operatorToken}` },
    }),
  );

const metricSum = async (
  instance: SpawnedInstance,
  name: string,
  labels: readonly string[],
): Promise<number> => {
  const response = await fetch(`${instance.baseUrl}/metrics`);
  const body = await response.text();
  return body
    .split('\n')
    .map((line) => METRIC_LINE.exec(line))
    .filter((match) => match?.[1] === name)
    .filter((match) => labels.every((label) => (match?.[2] ?? '').includes(label)))
    .reduce((sum, match) => sum + Number(match?.[3] ?? '0'), 0);
};

const metricTotal = async (
  instances: readonly SpawnedInstance[],
  name: string,
  labels: readonly string[] = [],
): Promise<number> => {
  const values = await Promise.all(instances.map((instance) => metricSum(instance, name, labels)));
  return values.reduce((sum, value) => sum + value, 0);
};

const loadOperations = (
  wallet: TestWallet,
  count: number,
  tag: string,
): WagerTransactionRequest[] =>
  Array.from({ length: count }, (_, index) => {
    const cents = String(index % 100).padStart(2, '0');
    const kind =
      index % 5 === 3
        ? WagerTransactionKind.Win
        : index % 5 === 4
          ? WagerTransactionKind.Loss
          : WagerTransactionKind.Bet;
    const amount = kind === WagerTransactionKind.Win ? `3.${cents}` : `1.${cents}`;
    return wagerCommand(kind, {
      wallet,
      amount,
      externalTransactionId: `${tag}-${String(index)}`,
      idempotencyKey: `${tag}-idem-${String(index)}`,
      roundId: `${tag}-round-${String(index)}`,
    });
  });

const settled = async (
  databaseUrl: string,
  walletId: string,
  expected: number,
): Promise<boolean> => {
  const rows = await queryRows(
    databaseUrl,
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'PENDING_REFERENCE')::int AS pending
       FROM wager_transactions
      WHERE wallet_id = $1 AND kind <> 'OPENING'`,
    [walletId],
  );
  const row = rows[0] ?? {};
  return row.total === expected && row.pending === 0;
};

const isNonDecreasing = (values: readonly number[]): boolean =>
  values.every((value, index) => index === 0 || value >= (values[index - 1] ?? value));

const stopAll = async (groups: readonly SpawnedInstances[]): Promise<void> => {
  await Promise.all(groups.map((group) => group.stop()));
};

describe('wallet reconciliation under mixed load', () => {
  it('stays consistent while http and queue traffic hit the same wallet', async () => {
    const database = await createTestDatabase();
    const queues = await createTestQueues();
    const issuer = await TestIssuer.start();
    const sqs = createTestSqsClient();
    const env = { DATABASE_URL: database.appUrl, ...queues.env, ...issuer.authConfig };
    const spawned = await Promise.allSettled([
      spawnInstances({ role: 'api', count: API_COUNT, env }),
      spawnInstances({ role: 'consumer', count: CONSUMER_COUNT, env }),
    ]);
    const groups = spawned.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    try {
      expect(spawned.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      const [apis, consumers] = groups;
      if (apis === undefined || consumers === undefined) {
        throw new RangeError('instances did not start');
      }
      const everyInstance = [...apis.instances, ...consumers.instances];
      const operatorToken = await issuer.token({ role: 'operator' });
      const providerToken = await issuer.token({ role: 'provider', providerId: TEST_PROVIDER_ID });
      const wallet = await createWalletViaApi(apis.instance(0).baseUrl, operatorToken, {
        initialBalance: { amount: '500.00', currency: 'BRL' },
      });
      const tag = `rec-${randomUUID()}`;
      const httpOperations = loadOperations(wallet, HTTP_OPERATIONS, `${tag}-http`);
      const queueOperations = loadOperations(wallet, QUEUE_OPERATIONS, `${tag}-sqs`);
      const mismatchBefore = await metricTotal(everyInstance, MISMATCH_METRIC);

      let loadFinished = false;
      const loops = apis.instances.map(async (instance, loop) => {
        const samples: ReconciliationSample[] = [];
        const statuses: number[] = [];
        while (!loadFinished || samples.length < MIN_RECONCILIATIONS_PER_LOOP) {
          const answer = await reconcile(instance.baseUrl, operatorToken, wallet.id);
          statuses.push(answer.status);
          if (answer.status === 200) {
            samples.push({ loop, body: answer.body });
          }
        }
        return { samples, statuses };
      });

      const load = Promise.all([
        ...httpOperations.map((request, index) =>
          withRetry(() =>
            submitViaApi(apis.instance(index % API_COUNT).baseUrl, providerToken, request),
          ).then((answer) => answer.status),
        ),
        ...queueOperations.map((request) =>
          publishEnvelope(
            sqs,
            queues.urls.wagerTransactions,
            buildEnvelope({ data: toMessageData(request) }),
            { groupId: randomUUID() },
          ).then(() => 0),
        ),
      ]);
      const loadStatuses = await load;
      await waitFor(
        () => settled(database.appUrl, wallet.id, HTTP_OPERATIONS + QUEUE_OPERATIONS),
        SETTLE_WAIT,
      );
      await waitFor(
        async () => (await countMessages(sqs, queues.urls.wagerTransactions)).total === 0,
        SETTLE_WAIT,
      );
      loadFinished = true;
      const results = await Promise.all(loops);

      expect(loadStatuses.filter((status) => ![0, 200, 422].includes(status))).toEqual([]);
      const samples = results.flatMap((result) => result.samples);
      expect(
        results.flatMap((result) => result.statuses).filter((status) => status !== 200),
      ).toEqual([]);
      expect(samples.length).toBeGreaterThanOrEqual(API_COUNT * MIN_RECONCILIATIONS_PER_LOOP);
      expect(samples.filter((sample) => sample.body.consistent !== true)).toEqual([]);
      samples.forEach((sample) => {
        expect(sample.body).toMatchObject({
          walletId: wallet.id,
          consistent: true,
          difference: { amount: '0.00', currency: 'BRL' },
          chain: { valid: true, firstDivergentVersion: null, problems: [] },
        });
        expect(sample.body.calculatedBalance).toEqual(sample.body.storedBalance);
      });
      results.forEach((result) => {
        expect(
          isNonDecreasing(result.samples.map((sample) => Number(sample.body.checkedEntries))),
        ).toBe(true);
      });
      const observedEntries = new Set(samples.map((sample) => Number(sample.body.checkedEntries)));
      expect(observedEntries.size).toBeGreaterThan(1);

      const final = await reconcile(apis.instance(0).baseUrl, operatorToken, wallet.id);
      const ledger = await queryRows(
        database.appUrl,
        `SELECT w.balance::text AS balance,
                (SELECT count(*)::int FROM wallet_ledger_entries e WHERE e.wallet_id = w.id) AS entries
           FROM wallets w WHERE w.id = $1`,
        [wallet.id],
      );
      expect(final.status).toBe(200);
      expect(final.body).toMatchObject({
        consistent: true,
        storedBalance: { amount: ledger[0]?.balance, currency: 'BRL' },
        checkedEntries: ledger[0]?.entries,
      });

      const runs = await queryRows(
        database.appUrl,
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE NOT consistent)::int AS inconsistent
           FROM reconciliation_runs WHERE scope = 'WALLET' AND wallet_id = $1`,
        [wallet.id],
      );
      expect(runs[0]?.inconsistent).toBe(0);
      expect(Number(runs[0]?.total)).toBeGreaterThanOrEqual(samples.length + 1);
      expect(mismatchBefore).toBe(0);
      expect(await metricTotal(everyInstance, MISMATCH_METRIC)).toBe(0);
      expect(await metricTotal(apis.instances, RUNS_METRIC, ['consistent="false"'])).toBe(0);
      expect(await metricTotal(apis.instances, RUNS_METRIC, ['consistent="true"'])).toBe(
        Number(runs[0]?.total),
      );
    } finally {
      sqs.destroy();
      await stopAll(groups);
      await issuer.stop();
    }
  });
});

describe('concurrent wallet creation on several apis', () => {
  it('creates one wallet per player and currency and answers the rest with the same id', async () => {
    const database = await createTestDatabase();
    const queues = await createTestQueues();
    const issuer = await TestIssuer.start();
    const env = { DATABASE_URL: database.appUrl, ...queues.env, ...issuer.authConfig };
    const groups: SpawnedInstances[] = [];
    try {
      const apis = await spawnInstances({ role: 'api', count: API_COUNT, env });
      groups.push(apis);
      const operatorToken = await issuer.token({ role: 'operator' });
      const playerId = randomUUID();
      const currencies = ['BRL', 'USD'] as const;
      const create = (baseUrl: string, currency: string): Promise<Answer> =>
        withRetry(() =>
          fetch(`${baseUrl}/wallets`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${operatorToken}`,
            },
            body: JSON.stringify({ playerId, initialBalance: { amount: '50.00', currency } }),
          }),
        );

      const answers = await Promise.all(
        currencies.flatMap((currency) =>
          Array.from({ length: API_COUNT * WALLET_CREATIONS_PER_API }, (_, index) =>
            create(apis.instance(index % API_COUNT).baseUrl, currency).then((answer) => ({
              currency,
              answer,
            })),
          ),
        ),
      );

      const createdIds = currencies.map((currency) => {
        const forCurrency = answers
          .filter((entry) => entry.currency === currency)
          .map((entry) => entry.answer);
        const created = forCurrency.filter((answer) => answer.status === 201);
        const conflicts = forCurrency.filter((answer) => answer.status === 409);
        expect(created).toHaveLength(1);
        expect(conflicts).toHaveLength(API_COUNT * WALLET_CREATIONS_PER_API - 1);
        const walletId = created[0]?.body.id;
        expect(typeof walletId).toBe('string');
        expect(created[0]?.body).toEqual({
          id: walletId,
          playerId,
          balance: { amount: '50.00', currency },
          version: expect.any(Number),
        });
        conflicts.forEach((answer) => {
          expect(answer.body).toMatchObject({
            status: 409,
            failureCode: 'WALLET_ALREADY_EXISTS',
            walletId,
          });
        });
        return walletId;
      });
      expect(new Set(createdIds).size).toBe(currencies.length);

      const wallets = await queryRows(
        database.appUrl,
        `SELECT w.id, w.currency, w.balance::text AS balance,
                (SELECT count(*)::int FROM wager_transactions t
                  WHERE t.wallet_id = w.id AND t.kind = 'OPENING') AS openings,
                (SELECT count(*)::int FROM wallet_ledger_entries e WHERE e.wallet_id = w.id) AS entries
           FROM wallets w WHERE w.player_id = $1 ORDER BY w.currency`,
        [playerId],
      );
      expect(wallets).toEqual([
        { id: createdIds[0], currency: 'BRL', balance: '50.00', openings: 1, entries: 1 },
        { id: createdIds[1], currency: 'USD', balance: '50.00', openings: 1, entries: 1 },
      ]);
    } finally {
      await stopAll(groups);
      await issuer.stop();
    }
  });
});
