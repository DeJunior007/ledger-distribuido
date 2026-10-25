import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { loadConfig } from '@infrastructure/config/env.schema';
import { closeOrmInstances, openOrmInstances } from '@infrastructure/persistence/orm-instances';
import { NO_FAULT_ENV } from '@test/support/fault-env';
import { betCommand, createWalletViaUseCase, toMessageData } from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import { SIGTERM_EXIT_CODE, spawnInstances } from '@test/support/spawn-instances';
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
import { createTestQueues } from '@test/support/test-queues';
import type { TestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

const WAIT = { timeoutMs: 60_000, intervalMs: 100 } as const;
const EXIT_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 180_000;
const STUCK_LOCK_ENV = {
  DB_LOCK_TIMEOUT_MS: '12000',
  DB_STATEMENT_TIMEOUT_MS: '13000',
  DB_QUERY_TIMEOUT_MS: '14000',
} as const;

interface ShutdownHarness {
  readonly database: TestDatabase;
  readonly queues: TestQueues;
  readonly wallet: TestWallet;
  readonly env: Readonly<Record<string, string>>;
}

const queryRows = async (
  databaseUrl: string,
  sql: string,
  params: readonly unknown[] = [],
): Promise<Record<string, unknown>[]> => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<Record<string, unknown>>(sql, [...params]);
    return result.rows;
  } finally {
    await client.end();
  }
};

const prepare = async (): Promise<ShutdownHarness> => {
  const database = await createTestDatabase();
  const queues = await createTestQueues();
  const config = loadConfig({ DATABASE_URL: database.appUrl }, { role: 'consumer' });
  const orm = await openOrmInstances(config);
  try {
    const wallet = await createWalletViaUseCase({ orm, config });
    return {
      database,
      queues,
      wallet,
      env: { DATABASE_URL: database.appUrl, ...queues.env, ...NO_FAULT_ENV, ...STUCK_LOCK_ENV },
    };
  } finally {
    await closeOrmInstances(orm);
  }
};

const holdWalletLock = async (database: TestDatabase, walletId: string): Promise<Client> => {
  const client = new Client({ connectionString: database.superuserUrl });
  await client.connect();
  await client.query('begin');
  await client.query('select id from wallets where id = $1 for update', [walletId]);
  return client;
};

const releaseWalletLock = async (client: Client): Promise<void> => {
  try {
    await client.query('rollback');
  } finally {
    await client.end();
  }
};

const waitForLockWaiter = (database: TestDatabase): Promise<void> =>
  waitFor(async () => {
    const rows = await queryRows(
      database.superuserUrl,
      `select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and usename = 'jungle_app' and wait_event_type = 'Lock'`,
    );
    return rows[0]?.waiting === 1;
  }, WAIT);

const transactionSummary = (database: TestDatabase, wallet: TestWallet) =>
  queryRows(
    database.superuserUrl,
    `select t.external_transaction_id, t.status,
            (select count(*)::int from ledger_entries l where l.transaction_id = t.id) as postings
       from wager_transactions t
      where t.wallet_id = $1 and t.kind = 'BET'
      order by t.external_transaction_id`,
    [wallet.id],
  );

const processedSummary = (envelopes: readonly WagerTransactionEnvelope[]) =>
  envelopes
    .map((envelope) => ({
      external_transaction_id: envelope.data.externalTransactionId,
      status: 'PROCESSED',
      postings: 2,
    }))
    .sort((left, right) =>
      left.external_transaction_id.localeCompare(right.external_transaction_id),
    );

const processedInbox = async (
  database: TestDatabase,
  envelopes: readonly WagerTransactionEnvelope[],
): Promise<unknown> => {
  const rows = await queryRows(
    database.superuserUrl,
    `select count(*)::int as processed from inbox_messages
      where message_id = any($1::text[]) and processed_at is not null`,
    [envelopes.map((envelope) => envelope.messageId)],
  );
  return rows[0]?.processed;
};

describe('wager transaction consumer shutdown', () => {
  it(
    'finishes the message in progress on SIGTERM and exits',
    async () => {
      const { database, queues, wallet, env } = await prepare();
      const sqs = createTestSqsClient();
      const envelope = buildEnvelope({ data: toMessageData(betCommand({ wallet })) });
      let lock: Client | undefined = await holdWalletLock(database, wallet.id);
      let consumers: SpawnedInstances | undefined;
      try {
        await publishEnvelope(sqs, queues.urls.wagerTransactions, envelope);
        consumers = await spawnInstances({ role: 'consumer', count: 1, env });
        const consumer = consumers.instance(0);
        await waitForLockWaiter(database);

        const exited = consumer.kill('SIGTERM', EXIT_TIMEOUT_MS);
        await releaseWalletLock(lock);
        lock = undefined;

        expect(await exited).toBe(SIGTERM_EXIT_CODE);
        expect(await countMessages(sqs, queues.urls.wagerTransactions)).toEqual({
          visible: 0,
          inFlight: 0,
          total: 0,
        });
        expect(await transactionSummary(database, wallet)).toEqual(processedSummary([envelope]));
        expect(await processedInbox(database, [envelope])).toBe(1);
      } finally {
        if (lock !== undefined) {
          await releaseWalletLock(lock);
        }
        await consumers?.stop();
        sqs.destroy();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'returns the unfinished messages to the queue on SIGTERM and applies them once after restart',
    async () => {
      const { database, queues, wallet, env } = await prepare();
      const sqs = createTestSqsClient();
      const stuck = buildEnvelope({ data: toMessageData(betCommand({ wallet })) });
      const behind = buildEnvelope({ data: toMessageData(betCommand({ wallet })) });
      let lock: Client | undefined = await holdWalletLock(database, wallet.id);
      let consumers: SpawnedInstances | undefined;
      try {
        await publishEnvelope(sqs, queues.urls.wagerTransactions, stuck, { groupId: wallet.id });
        await publishEnvelope(sqs, queues.urls.wagerTransactions, behind, { groupId: wallet.id });
        consumers = await spawnInstances({ role: 'consumer', count: 1, env });
        const consumer = consumers.instance(0);
        await waitForLockWaiter(database);

        expect(await consumer.kill('SIGTERM', EXIT_TIMEOUT_MS)).toBe(SIGTERM_EXIT_CODE);
        expect(await countMessages(sqs, queues.urls.wagerTransactions)).toEqual({
          visible: 2,
          inFlight: 0,
          total: 2,
        });
        expect(await transactionSummary(database, wallet)).toEqual([]);
        expect(await processedInbox(database, [stuck, behind])).toBe(0);

        await releaseWalletLock(lock);
        lock = undefined;
        await consumer.restart();
        await waitFor(
          async () => (await countMessages(sqs, queues.urls.wagerTransactions)).total === 0,
          WAIT,
        );
        expect(await transactionSummary(database, wallet)).toEqual(
          processedSummary([stuck, behind]),
        );
        expect(await processedInbox(database, [stuck, behind])).toBe(2);
        expect((await countMessages(sqs, queues.urls.wagerTransactionsDlq)).total).toBe(0);
      } finally {
        if (lock !== undefined) {
          await releaseWalletLock(lock);
        }
        await consumers?.stop();
        sqs.destroy();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
