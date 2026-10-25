import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import type { WagerTransactionRequest } from '@interfaces/http/schemas/wager-transaction.schema';
import {
  betCommand,
  createWalletViaApi,
  rollbackCommand,
  submitViaApi,
  toMessageData,
  winCommand,
} from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import { spawnInstances } from '@test/support/spawn-instances';
import type { SpawnedInstances } from '@test/support/spawn-instances';
import {
  buildEnvelope,
  countMessages,
  createTestSqsClient,
  publishEnvelope,
} from '@test/support/sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { createTestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID, TestIssuer } from '@test/support/test-issuer';
import type { TestQueues } from '@test/support/test-queues';
import { createTestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

const API_COUNT = 3;
const CONSUMER_COUNT = 2;
const RACE_ROUNDS = 6;
const RACE_BETS = 18;
const SMALL_CREDITS = 3;
const SMALL_BETS = 3;
const TRANSIENT_STATUS = 503;
const MAX_ATTEMPTS = 10;
const RETRY_BACKOFF_MS = 200;
const SETTLE_WAIT = { timeoutMs: 120_000, intervalMs: 250 } as const;

type Json = Record<string, unknown>;

interface Answer {
  readonly status: number;
  readonly body: Json;
}

interface Harness {
  readonly databaseUrl: string;
  readonly apis: SpawnedInstances;
  readonly queues: TestQueues;
  readonly sqs: SQSClient;
  readonly operatorToken: string;
  readonly providerToken: string;
}

interface Dispatch {
  readonly request: WagerTransactionRequest;
  readonly channel: 'http' | 'sqs';
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

const submitWithRetry = async (
  baseUrl: string,
  providerToken: string,
  request: WagerTransactionRequest,
): Promise<Answer> => {
  for (let attempt = 1; ; attempt += 1) {
    const answer = await readAnswer(await submitViaApi(baseUrl, providerToken, request));
    if (answer.status !== TRANSIENT_STATUS || attempt >= MAX_ATTEMPTS) {
      return answer;
    }
    await Bun.sleep(RETRY_BACKOFF_MS * attempt);
  }
};

const dispatchAll = (
  harness: Harness,
  dispatches: readonly Dispatch[],
): Promise<(Answer | undefined)[]> =>
  Promise.all(
    dispatches.map(async (dispatch, index) => {
      if (dispatch.channel === 'http') {
        return submitWithRetry(
          harness.apis.instance(index % API_COUNT).baseUrl,
          harness.providerToken,
          dispatch.request,
        );
      }
      await publishEnvelope(
        harness.sqs,
        harness.queues.urls.wagerTransactions,
        buildEnvelope({ data: toMessageData(dispatch.request) }),
        { groupId: randomUUID() },
      );
      return undefined;
    }),
  );

const transactionsOf = (databaseUrl: string, walletId: string): Promise<Json[]> =>
  queryRows(
    databaseUrl,
    `SELECT t.id, t.external_transaction_id AS "externalId", t.kind, t.status,
            t.failure_code AS "failureCode", t.amount::text AS amount,
            t.balance_snapshot_amount::text AS snapshot,
            r.external_transaction_id AS "referenceExternalId"
       FROM wager_transactions t
       LEFT JOIN wager_transactions r ON r.id = t.reference_transaction_id
      WHERE t.wallet_id = $1 AND t.kind <> 'OPENING'
      ORDER BY t.created_at, t.id`,
    [walletId],
  );

const ledgerOf = (databaseUrl: string, walletId: string): Promise<Json[]> =>
  queryRows(
    databaseUrl,
    `SELECT e.transaction_id AS "transactionId", e.direction, e.amount::text AS amount,
            e.balance_before::text AS "balanceBefore", e.balance_after::text AS "balanceAfter"
       FROM wallet_ledger_entries e
      WHERE e.wallet_id = $1
      ORDER BY e.wallet_version`,
    [walletId],
  );

const balanceOf = async (databaseUrl: string, walletId: string): Promise<Json> => {
  const rows = await queryRows(
    databaseUrl,
    `SELECT w.balance::text AS stored,
            (SELECT coalesce(sum(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END), 0)
               FROM wallet_ledger_entries e WHERE e.wallet_id = w.id)::text AS calculated
       FROM wallets w WHERE w.id = $1`,
    [walletId],
  );
  return rows[0] ?? {};
};

const settled = async (harness: Harness, walletId: string, expected: number): Promise<boolean> => {
  const rows = await transactionsOf(harness.databaseUrl, walletId);
  if (rows.length !== expected || rows.some((row) => row.status === 'PENDING_REFERENCE')) {
    return false;
  }
  return (await countMessages(harness.sqs, harness.queues.urls.wagerTransactions)).total === 0;
};

const cents = (amount: unknown): bigint => {
  const [units = '0', fraction = '00'] = String(amount).split('.');
  return BigInt(units) * 100n + BigInt(fraction.padEnd(2, '0'));
};

const withKind = (rows: readonly Json[], kind: string): Json[] =>
  rows.filter((row) => row.kind === kind);

const withStatus = (rows: readonly Json[], status: string): Json[] =>
  rows.filter((row) => row.status === status);

const interleave = <T>(groups: readonly (readonly T[])[]): T[] => {
  const longest = Math.max(...groups.map((group) => group.length));
  return Array.from({ length: longest }, (_, index) =>
    groups.flatMap((group) => {
      const item = group[index];
      return item === undefined ? [] : [item];
    }),
  ).flat();
};

const startHarness = async (
  run: (harness: Harness, wallet: (balance: string) => Promise<TestWallet>) => Promise<void>,
): Promise<void> => {
  const database = await createTestDatabase();
  const queues = await createTestQueues();
  const issuer = await TestIssuer.start();
  const sqs = createTestSqsClient();
  const env = { DATABASE_URL: database.appUrl, ...queues.env, ...issuer.authConfig };
  const spawned = await Promise.allSettled([
    spawnInstances({ role: 'api', count: API_COUNT, env }),
    spawnInstances({ role: 'consumer', count: CONSUMER_COUNT, env }),
    spawnInstances({ role: 'scheduler', count: 1, env }),
  ]);
  const groups = spawned.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  try {
    expect(spawned.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    const [apis] = groups;
    if (apis === undefined) {
      throw new RangeError('api instances did not start');
    }
    const operatorToken = await issuer.token({ role: 'operator' });
    const providerToken = await issuer.token({ role: 'provider', providerId: TEST_PROVIDER_ID });
    const harness: Harness = {
      databaseUrl: database.appUrl,
      apis,
      queues,
      sqs,
      operatorToken,
      providerToken,
    };
    await run(harness, (balance) =>
      createWalletViaApi(apis.instance(0).baseUrl, operatorToken, {
        initialBalance: { amount: balance, currency: 'BRL' },
      }),
    );
  } finally {
    sqs.destroy();
    await Promise.all(groups.map((group) => group.stop()));
    await issuer.stop();
  }
};

const expectNeverNegative = (ledger: readonly Json[]): void => {
  expect(
    ledger.filter((entry) => cents(entry.balanceBefore) < 0n || cents(entry.balanceAfter) < 0n),
  ).toEqual([]);
};

describe('reversal funds race', () => {
  it('races wins, rollbacks of those wins and bets on a low balance wallet', async () => {
    await startHarness(async (harness, openWallet) => {
      const wallet = await openWallet('10.00');
      const tag = `race-${randomUUID()}`;
      const rounds = Array.from({ length: RACE_ROUNDS }, (_, round) => {
        const roundId = `${tag}-round-${String(round)}`;
        const winId = `${tag}-win-${String(round)}`;
        return {
          win: winCommand({
            wallet,
            amount: '20.00',
            roundId,
            externalTransactionId: winId,
            idempotencyKey: `${winId}-key`,
          }),
          rollback: rollbackCommand({
            wallet,
            amount: '20.00',
            roundId,
            externalTransactionId: `${tag}-rollback-${String(round)}`,
            idempotencyKey: `${tag}-rollback-${String(round)}-key`,
            referenceExternalTransactionId: winId,
          }),
        };
      });
      const bets = Array.from({ length: RACE_BETS }, (_, index) =>
        betCommand({ wallet, amount: '10.00', roundId: `${tag}-bet-round-${String(index)}` }),
      );
      const ordered = interleave([
        rounds.map((round) => round.rollback),
        bets.slice(0, RACE_BETS / 2),
        rounds.map((round) => round.win),
        bets.slice(RACE_BETS / 2),
      ]);
      const dispatches: Dispatch[] = ordered.map((request, index) => ({
        request,
        channel: index % 3 === 2 ? 'sqs' : 'http',
      }));

      const answers = await dispatchAll(harness, dispatches);
      await waitFor(() => settled(harness, wallet.id, ordered.length), SETTLE_WAIT);

      const httpAnswers = answers.flatMap((answer) => (answer === undefined ? [] : [answer]));
      expect(httpAnswers.filter((answer) => ![200, 202, 422].includes(answer.status))).toEqual([]);
      httpAnswers
        .filter((answer) => answer.status === 422)
        .forEach((answer) => {
          expect(answer.body.failureCode).toBe(
            answer.body.kind === 'ROLLBACK'
              ? 'INSUFFICIENT_FUNDS_FOR_REVERSAL'
              : 'INSUFFICIENT_FUNDS',
          );
        });

      const transactions = await transactionsOf(harness.databaseUrl, wallet.id);
      const wins = withKind(transactions, 'WIN');
      const rollbacks = withKind(transactions, 'ROLLBACK');
      const placedBets = withKind(transactions, 'BET');
      expect(
        transactions.filter((row) => !['PROCESSED', 'REJECTED'].includes(String(row.status))),
      ).toEqual([]);
      expect(withStatus(wins, 'PROCESSED')).toHaveLength(RACE_ROUNDS);
      withStatus(placedBets, 'REJECTED').forEach((bet) => {
        expect(bet.failureCode).toBe('INSUFFICIENT_FUNDS');
        expect(cents(bet.snapshot)).toBeLessThan(cents(bet.amount));
      });
      withStatus(rollbacks, 'REJECTED').forEach((rollback) => {
        expect(rollback.failureCode).toBe('INSUFFICIENT_FUNDS_FOR_REVERSAL');
        expect(cents(rollback.snapshot)).toBeLessThan(cents(rollback.amount));
      });
      const reversedWins = withStatus(rollbacks, 'PROCESSED').map((row) => row.referenceExternalId);
      expect(new Set(reversedWins).size).toBe(reversedWins.length);

      const ledger = await ledgerOf(harness.databaseUrl, wallet.id);
      expectNeverNegative(ledger);
      const processedIds = new Set(withStatus(transactions, 'PROCESSED').map((row) => row.id));
      expect(ledger.filter((entry) => processedIds.has(entry.transactionId))).toHaveLength(
        processedIds.size,
      );
      withStatus(rollbacks, 'PROCESSED').forEach((rollback) => {
        const entry = ledger.find((candidate) => candidate.transactionId === rollback.id);
        expect(entry?.direction).toBe('DEBIT');
        expect(cents(entry?.balanceBefore)).toBeGreaterThanOrEqual(cents(rollback.amount));
      });

      const expected =
        1000n +
        2000n * BigInt(withStatus(wins, 'PROCESSED').length) -
        2000n * BigInt(withStatus(rollbacks, 'PROCESSED').length) -
        1000n * BigInt(withStatus(placedBets, 'PROCESSED').length);
      const balance = await balanceOf(harness.databaseUrl, wallet.id);
      expect(balance.stored).toBe(balance.calculated);
      expect(cents(balance.stored)).toBe(expected);
      expect(cents(ledger.at(-1)?.balanceAfter)).toBe(expected);
    });
  });

  it('rejects the rollback of a spent win while smaller credits and bets race it', async () => {
    await startHarness(async (harness, openWallet) => {
      const wallet = await openWallet('0.00');
      const tag = `spent-${randomUUID()}`;
      const roundId = `${tag}-round`;
      const win = winCommand({
        wallet,
        amount: '20.00',
        roundId,
        externalTransactionId: `${tag}-win`,
        idempotencyKey: `${tag}-win-key`,
      });
      const spend = betCommand({ wallet, amount: '20.00', roundId: `${tag}-spend` });
      const rollback = rollbackCommand({
        wallet,
        amount: '20.00',
        roundId,
        externalTransactionId: `${tag}-rollback`,
        idempotencyKey: `${tag}-rollback-key`,
        referenceExternalTransactionId: `${tag}-win`,
      });
      const baseUrl = harness.apis.instance(0).baseUrl;
      expect((await submitWithRetry(baseUrl, harness.providerToken, win)).status).toBe(200);
      expect((await submitWithRetry(baseUrl, harness.providerToken, spend)).body).toMatchObject({
        status: 'PROCESSED',
        balance: { amount: '0.00', currency: 'BRL' },
      });

      const credits = Array.from({ length: SMALL_CREDITS }, (_, index) =>
        winCommand({ wallet, amount: '5.00', roundId: `${tag}-credit-${String(index)}` }),
      );
      const debits = Array.from({ length: SMALL_BETS }, (_, index) =>
        betCommand({ wallet, amount: '5.00', roundId: `${tag}-debit-${String(index)}` }),
      );
      const [credit0, credit1, credit2] = credits;
      const [debit0, debit1, debit2] = debits;
      if (
        credit0 === undefined ||
        credit1 === undefined ||
        credit2 === undefined ||
        debit0 === undefined ||
        debit1 === undefined ||
        debit2 === undefined
      ) {
        throw new RangeError('race operations were not built');
      }
      const dispatches: Dispatch[] = [
        { request: credit0, channel: 'http' },
        { request: rollback, channel: 'http' },
        { request: debit0, channel: 'http' },
        { request: credit1, channel: 'sqs' },
        { request: debit1, channel: 'http' },
        { request: rollback, channel: 'http' },
        { request: credit2, channel: 'http' },
        { request: rollback, channel: 'sqs' },
        { request: debit2, channel: 'sqs' },
      ];

      const answers = await dispatchAll(harness, dispatches);
      await waitFor(
        () => settled(harness, wallet.id, 2 + 1 + SMALL_CREDITS + SMALL_BETS),
        SETTLE_WAIT,
      );

      const rollbackAnswers = answers.filter(
        (answer): answer is Answer => answer?.body.kind === 'ROLLBACK',
      );
      expect(rollbackAnswers).toHaveLength(2);
      const [firstAnswer, secondAnswer] = rollbackAnswers;
      expect(firstAnswer?.status).toBe(422);
      expect(secondAnswer?.status).toBe(422);
      expect(firstAnswer?.body).toMatchObject({
        status: 'REJECTED',
        kind: 'ROLLBACK',
        failureCode: 'INSUFFICIENT_FUNDS_FOR_REVERSAL',
      });
      expect(secondAnswer?.body.transactionId).toBe(firstAnswer?.body.transactionId);
      expect(secondAnswer?.body.failureCode).toBe('INSUFFICIENT_FUNDS_FOR_REVERSAL');

      const transactions = await transactionsOf(harness.databaseUrl, wallet.id);
      const rollbacks = withKind(transactions, 'ROLLBACK');
      expect(rollbacks).toEqual([
        {
          id: firstAnswer?.body.transactionId,
          externalId: `${tag}-rollback`,
          kind: 'ROLLBACK',
          status: 'REJECTED',
          failureCode: 'INSUFFICIENT_FUNDS_FOR_REVERSAL',
          amount: '20.00',
          snapshot: expect.any(String),
          referenceExternalId: `${tag}-win`,
        },
      ]);
      expect(cents(rollbacks[0]?.snapshot)).toBeLessThan(2000n);
      const smallWins = withKind(transactions, 'WIN').filter((row) => row.amount === '5.00');
      expect(withStatus(smallWins, 'PROCESSED')).toHaveLength(SMALL_CREDITS);
      const smallBets = withKind(transactions, 'BET').filter((row) => row.amount === '5.00');
      withStatus(smallBets, 'REJECTED').forEach((bet) => {
        expect(bet.failureCode).toBe('INSUFFICIENT_FUNDS');
      });

      const ledgerBefore = await ledgerOf(harness.databaseUrl, wallet.id);
      expectNeverNegative(ledgerBefore);
      expect(ledgerBefore.some((entry) => entry.transactionId === rollbacks[0]?.id)).toBe(false);
      const expected = 1500n - 500n * BigInt(withStatus(smallBets, 'PROCESSED').length);
      const balance = await balanceOf(harness.databaseUrl, wallet.id);
      expect(balance.stored).toBe(balance.calculated);
      expect(cents(balance.stored)).toBe(expected);

      const topUp = winCommand({ wallet, amount: '100.00', roundId: `${tag}-top-up` });
      expect((await submitWithRetry(baseUrl, harness.providerToken, topUp)).status).toBe(200);
      const replay = await submitWithRetry(
        harness.apis.instance(API_COUNT - 1).baseUrl,
        harness.providerToken,
        rollback,
      );
      expect(replay.status).toBe(422);
      expect(replay.body).toMatchObject({
        transactionId: firstAnswer?.body.transactionId,
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS_FOR_REVERSAL',
        idempotentReplay: true,
      });
      const ledgerAfter = await ledgerOf(harness.databaseUrl, wallet.id);
      expect(ledgerAfter.some((entry) => entry.transactionId === rollbacks[0]?.id)).toBe(false);
      expect(ledgerAfter).toHaveLength(ledgerBefore.length + 1);
    });
  });
});
