import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { registerCurrentDatabase } from '@test/support/current-database';
import { betCommand, createWalletViaApi, toMessageData } from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import { spawnInstances } from '@test/support/spawn-instances';
import type { SpawnedInstances } from '@test/support/spawn-instances';
import {
  buildEnvelope,
  countMessages,
  createTestSqsClient,
  publishEnvelope,
} from '@test/support/sqs';
import type { WagerTransactionEnvelope } from '@test/support/sqs';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TestIssuer } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';
import type { TestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

const CONSUMER_COUNT = 2;
const COPIES = 3;
const SETTLE_WAIT = { timeoutMs: 60_000, intervalMs: 200 } as const;

let database: TestDatabase;
let queues: TestQueues;
let issuer: TestIssuer;
let sqs: SQSClient;
let groups: SpawnedInstances[];
let operatorToken: string;

const queryRows = async (
  sql: string,
  params: readonly unknown[] = [],
): Promise<Record<string, unknown>[]> => {
  const client = new Client({ connectionString: database.superuserUrl });
  await client.connect();
  try {
    const result = await client.query<Record<string, unknown>>(sql, [...params]);
    return result.rows;
  } finally {
    await client.end();
  }
};

const apiUrl = (): string => {
  const [apis] = groups;
  if (apis === undefined) {
    throw new RangeError('api instance did not start');
  }
  return apis.instance(0).baseUrl;
};

const newWallet = (): Promise<TestWallet> =>
  createWalletViaApi(apiUrl(), operatorToken, {
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });

const transactionStatuses = async (envelope: WagerTransactionEnvelope): Promise<unknown[]> =>
  (
    await queryRows(
      `SELECT status FROM wager_transactions
        WHERE provider_id = $1 AND external_transaction_id = $2`,
      [envelope.data.providerId, envelope.data.externalTransactionId],
    )
  ).map((row) => row.status);

const settle = async (envelope: WagerTransactionEnvelope): Promise<void> => {
  await waitFor(
    async () =>
      (await countMessages(sqs, queues.urls.wagerTransactions)).total === 0 &&
      (await transactionStatuses(envelope)).length > 0,
    SETTLE_WAIT,
  );
};

const effectOf = async (wallet: TestWallet, envelope: WagerTransactionEnvelope) => ({
  transactions: await transactionStatuses(envelope),
  ledger: await queryRows(
    `SELECT direction, amount::text AS amount FROM wallet_ledger_entries
      WHERE wallet_id = $1 ORDER BY wallet_version`,
    [wallet.id],
  ),
  dlq: (await countMessages(sqs, queues.urls.wagerTransactionsDlq)).total,
});

const ONE_DEBIT = {
  transactions: ['PROCESSED'],
  ledger: [
    { direction: 'CREDIT', amount: '100.00' },
    { direction: 'DEBIT', amount: '10.00' },
  ],
  dlq: 0,
};

const operationFor = (wallet: TestWallet): WagerTransactionEnvelope =>
  buildEnvelope({ data: toMessageData(betCommand({ wallet, amount: '10.00' })) });

const copiesWithNewMessageIds = (envelope: WagerTransactionEnvelope): WagerTransactionEnvelope[] =>
  Array.from({ length: COPIES }, () => ({ ...envelope, messageId: `msg-${randomUUID()}` }));

beforeAll(async () => {
  database = await createTestDatabase();
  queues = await createTestQueues();
  issuer = await TestIssuer.start();
  sqs = createTestSqsClient();
  const env = { DATABASE_URL: database.appUrl, ...queues.env, ...issuer.authConfig };
  const spawned = await Promise.allSettled([
    spawnInstances({ role: 'api', count: 1, env }),
    spawnInstances({ role: 'consumer', count: CONSUMER_COUNT, env }),
  ]);
  groups = spawned.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  const failed = spawned.find((result) => result.status === 'rejected');
  if (failed !== undefined) {
    throw failed.reason;
  }
  operatorToken = await issuer.token({ role: 'operator' });
});

beforeEach(() => {
  registerCurrentDatabase(database.superuserUrl);
});

afterAll(async () => {
  sqs.destroy();
  await Promise.all(groups.map((group) => group.stop()));
  await issuer.stop();
});

describe('§5.3 não confiar só no SQS FIFO', () => {
  it('applies once the same message sent with different MessageDeduplicationIds', async () => {
    const wallet = await newWallet();
    const envelope = operationFor(wallet);

    for (let copy = 0; copy < COPIES; copy += 1) {
      await publishEnvelope(sqs, queues.urls.wagerTransactions, envelope, {
        deduplicationId: `dedup-${randomUUID()}`,
      });
    }
    await settle(envelope);

    expect(await effectOf(wallet, envelope)).toEqual(ONE_DEBIT);
  });

  it('applies once the same operation sent under different messageIds', async () => {
    const wallet = await newWallet();
    const operation = operationFor(wallet);
    const copies = copiesWithNewMessageIds(operation);

    for (const copy of copies) {
      await publishEnvelope(sqs, queues.urls.wagerTransactions, copy);
    }
    await settle(operation);

    expect(await effectOf(wallet, operation)).toEqual(ONE_DEBIT);
  });

  it('applies once the same operation for one wallet sent in different message groups', async () => {
    const wallet = await newWallet();
    const operation = operationFor(wallet);
    const copies = copiesWithNewMessageIds(operation);

    await Promise.all(
      copies.map((copy) =>
        publishEnvelope(sqs, queues.urls.wagerTransactions, copy, { groupId: randomUUID() }),
      ),
    );
    await settle(operation);

    expect(await effectOf(wallet, operation)).toEqual(ONE_DEBIT);
  });
});
