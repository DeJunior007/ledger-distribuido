import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { FailureCode } from '@domain/shared/failure-code';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import type { WagerTransactionRequest } from '@interfaces/http/schemas/wager-transaction.schema';
import {
  betCommand,
  createWalletViaApi,
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
import { createTestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID, TestIssuer } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

type Json = Readonly<Record<string, unknown>>;

const API_COUNT = 3;
const CONSUMER_COUNT = 3;
const HTTP_OPERATIONS = 15;
const SQS_OPERATIONS = 15;
const INITIAL_UNITS = 1000;
const BET_UNITS = 7;
const WIN_UNITS = 3;
const MAX_HTTP_ATTEMPTS = 10;
const RETRY_AFTER_FALLBACK_SECONDS = 1;
const SETTLE_WAIT = { timeoutMs: 120_000, intervalMs: 250 } as const;
const CONSUMER_NAME = 'wager-transactions-consumer';
const CONTENDED_SERIES = 'jungle_lock_conflicts_total{type="contended"}';

const units = (value: number): string => `${String(value)}.00`;

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
  databaseUrl: string,
  sql: string,
  params: readonly unknown[],
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

const operationFor = (wallet: TestWallet, index: number): WagerTransactionRequest =>
  index % 2 === 0
    ? betCommand({ wallet, amount: units(BET_UNITS) })
    : winCommand({ wallet, amount: units(WIN_UNITS) });

const serialBalance = (operations: readonly WagerTransactionRequest[]): string =>
  units(
    operations.reduce(
      (balance, operation) =>
        operation.body.kind === WagerTransactionKind.Bet
          ? balance - BET_UNITS
          : balance + WIN_UNITS,
      INITIAL_UNITS,
    ),
  );

const isInfrastructureUnavailable = (status: number, body: Json): boolean =>
  status === 503 && body.failureCode === FailureCode.InfrastructureUnavailable;

const submitUntilSettled = async (
  baseUrl: string,
  token: string,
  request: WagerTransactionRequest,
): Promise<{ status: number; body: Json; attempts: number }> => {
  for (let attempt = 1; ; attempt += 1) {
    const response = await submitViaApi(baseUrl, token, request);
    const body = await jsonOf(response);
    if (!isInfrastructureUnavailable(response.status, body) || attempt >= MAX_HTTP_ATTEMPTS) {
      return { status: response.status, body, attempts: attempt };
    }
    const retryAfter = Number(response.headers.get('retry-after') ?? RETRY_AFTER_FALLBACK_SECONDS);
    await Bun.sleep(retryAfter * 1000);
  }
};

const contendedCount = async (instance: { baseUrl: string }): Promise<number> => {
  const response = await fetch(`${instance.baseUrl}/metrics`);
  const text = await response.text();
  const line = text.split('\n').find((candidate) => candidate.startsWith(`${CONTENDED_SERIES} `));
  return line === undefined ? 0 : Number(line.slice(CONTENDED_SERIES.length + 1));
};

const totalContended = async (groups: readonly SpawnedInstances[]): Promise<number> => {
  const counts = await Promise.all(
    groups.flatMap((group) => group.instances.map((instance) => contendedCount(instance))),
  );
  return counts.reduce((sum, count) => sum + count, 0);
};

describe('concurrency 10: the broker is not the guarantee', () => {
  it('matches the serial result when one wallet is hit through many message groups and http at once', async () => {
    const database = await createTestDatabase();
    const queues = await createTestQueues();
    const issuer = await TestIssuer.start();
    const sqs = createTestSqsClient();
    const env = { DATABASE_URL: database.appUrl, ...queues.env, ...issuer.authConfig };
    const groups: SpawnedInstances[] = [];
    try {
      const apis = await spawnInstances({ role: 'api', count: API_COUNT, env });
      groups.push(apis);
      groups.push(await spawnInstances({ role: 'consumer', count: CONSUMER_COUNT, env }));
      const operatorToken = await issuer.token({ role: 'operator' });
      const providerToken = await issuer.token({ role: 'provider', providerId: TEST_PROVIDER_ID });
      const wallet = await createWalletViaApi(apis.instance(0).baseUrl, operatorToken, {
        initialBalance: { amount: units(INITIAL_UNITS), currency: 'BRL' },
      });
      const httpOperations = Array.from({ length: HTTP_OPERATIONS }, (_, index) =>
        operationFor(wallet, index),
      );
      const sqsOperations = Array.from({ length: SQS_OPERATIONS }, (_, index) =>
        operationFor(wallet, index + 1),
      );
      const groupIds = sqsOperations.map(() => randomUUID());
      const contendedBefore = await totalContended(groups);

      const [httpOutcomes] = await Promise.all([
        Promise.all(
          httpOperations.map((request, index) =>
            submitUntilSettled(apis.instance(index % API_COUNT).baseUrl, providerToken, request),
          ),
        ),
        Promise.all(
          sqsOperations.map((request, index) =>
            publishEnvelope(
              sqs,
              queues.urls.wagerTransactions,
              buildEnvelope({ data: toMessageData(request) }),
              { groupId: groupIds[index] ?? randomUUID() },
            ),
          ),
        ),
      ]);

      for (const outcome of httpOutcomes) {
        expect(outcome.status).toBe(200);
        expect(outcome.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
      }
      expect(new Set(groupIds).size).toBe(SQS_OPERATIONS);

      const operations = [...httpOperations, ...sqsOperations];
      const externalIds = operations.map((operation) => operation.body.externalTransactionId);
      await waitFor(async () => {
        const settled = await queryRows(
          database.superuserUrl,
          `SELECT count(*)::int AS total FROM wager_transactions
            WHERE provider_id = $1 AND external_transaction_id = ANY($2::text[])
              AND status = 'PROCESSED'`,
          [TEST_PROVIDER_ID, externalIds],
        );
        const queue = await countMessages(sqs, queues.urls.wagerTransactions);
        return settled[0]?.total === operations.length && queue.total === 0;
      }, SETTLE_WAIT);

      const transactions = await queryRows(
        database.superuserUrl,
        `SELECT external_transaction_id AS "externalTransactionId", status
           FROM wager_transactions
          WHERE wallet_id = $1 AND kind IN ('BET', 'WIN')
          ORDER BY external_transaction_id`,
        [wallet.id],
      );
      expect(transactions).toEqual(
        [...externalIds].sort().map((externalTransactionId) => ({
          externalTransactionId,
          status: 'PROCESSED',
        })),
      );
      const walletRows = await queryRows(
        database.superuserUrl,
        'SELECT balance::text AS balance, version FROM wallets WHERE id = $1',
        [wallet.id],
      );
      expect(walletRows).toEqual([
        { balance: serialBalance(operations), version: wallet.version + operations.length },
      ]);
      const walletEntries = await queryRows(
        database.superuserUrl,
        `SELECT count(*)::int AS total FROM ledger_entries le
           JOIN wager_transactions wt ON wt.id = le.transaction_id
          WHERE wt.wallet_id = $1 AND wt.kind IN ('BET', 'WIN')`,
        [wallet.id],
      );
      expect(walletEntries).toEqual([{ total: operations.length * 2 }]);
      const inbox = await queryRows(
        database.superuserUrl,
        `SELECT count(*)::int AS total FROM inbox_messages
          WHERE consumer_name = $1 AND processed_at IS NOT NULL`,
        [CONSUMER_NAME],
      );
      expect(inbox).toEqual([{ total: SQS_OPERATIONS }]);
      expect((await totalContended(groups)) - contendedBefore).toBeGreaterThan(0);
    } finally {
      sqs.destroy();
      await Promise.all(groups.map((group) => group.stop()));
      await issuer.stop();
    }
  });
});
