import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Client } from 'pg';
import type { DestinationStream } from 'pino';
import { loadConfig } from '@infrastructure/config/env.schema';
import { closeOrmInstances, openOrmInstances } from '@infrastructure/persistence/orm-instances';
import { betCommand, createWalletViaUseCase, toMessageData } from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import { buildEnvelope, countMessages, publishEnvelope } from '@test/support/sqs';
import type { WagerTransactionEnvelope } from '@test/support/sqs';
import { createTestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { createTestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

const WAIT = { timeoutMs: 40_000, intervalMs: 100 } as const;
const TEST_TIMEOUT_MS = 90_000;
const BATCH_SIZE = 10;
const INITIAL_BALANCE_CENTS = 100_000n;
const CENTS_PER_UNIT = 100n;

interface CapturedLogs {
  readonly destination: DestinationStream;
  readonly entries: () => readonly Readonly<Record<string, unknown>>[];
}

const queryRows = async (
  databaseUrl: string,
  sql: string,
  params: readonly unknown[],
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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const captureLogs = (): CapturedLogs => {
  const lines: string[] = [];
  return {
    destination: {
      write(chunk: string): void {
        lines.push(chunk);
      },
    },
    entries: () =>
      lines.flatMap((line) => {
        const parsed: unknown = JSON.parse(line);
        return isRecord(parsed) ? [parsed] : [];
      }),
  };
};

const createWallets = async (database: TestDatabase, count: number): Promise<TestWallet[]> => {
  const config = loadConfig({ DATABASE_URL: database.appUrl }, { role: 'consumer' });
  const orm = await openOrmInstances(config);
  try {
    const wallets: TestWallet[] = [];
    for (let index = 0; index < count; index += 1) {
      wallets.push(await createWalletViaUseCase({ orm, config }));
    }
    return wallets;
  } finally {
    await closeOrmInstances(orm);
  }
};

const unitAmount = (units: bigint): string => `${String(units)}.00`;

const formatCents = (cents: bigint): string =>
  `${String(cents / CENTS_PER_UNIT)}.${String(cents % CENTS_PER_UNIT).padStart(2, '0')}`;

const runningBalances = (amounts: readonly bigint[]): string[] => {
  let cents = INITIAL_BALANCE_CENTS;
  return amounts.map((units) => {
    cents -= units * CENTS_PER_UNIT;
    return formatCents(cents);
  });
};

const snapshotsInProcessingOrder = (
  databaseUrl: string,
  walletId: string,
): Promise<Record<string, unknown>[]> =>
  queryRows(
    databaseUrl,
    `select t.external_transaction_id, t.status, t.balance_snapshot_amount, l.wallet_version
       from wager_transactions t
       join ledger_entries l on l.transaction_id = t.id and l.wallet_id = t.wallet_id
      where t.wallet_id = $1 and t.kind = 'BET'
      order by l.wallet_version`,
    [walletId],
  );

const processedCount = async (
  databaseUrl: string,
  walletIds: readonly string[],
): Promise<number> => {
  const rows = await queryRows(
    databaseUrl,
    `select count(*)::int as processed from wager_transactions
      where wallet_id = any($1::uuid[]) and kind = 'BET' and status = 'PROCESSED'`,
    [walletIds],
  );
  const processed = rows[0]?.processed;
  return typeof processed === 'number' ? processed : 0;
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

const publishInOrder = async (
  sqs: SQSClient,
  queueUrl: string,
  envelopes: readonly WagerTransactionEnvelope[],
  groupId: string,
): Promise<void> => {
  for (const envelope of envelopes) {
    await publishEnvelope(sqs, queueUrl, envelope, { groupId });
  }
};

describe('wager transaction consumer ordering', () => {
  it(
    'applies ten messages of one group in the order they were sent',
    async () => {
      const database = await createTestDatabase();
      const queues = await createTestQueues();
      const [wallet] = await createWallets(database, 1);
      if (wallet === undefined) {
        throw new TypeError('wallet was not created');
      }
      const amounts = Array.from({ length: BATCH_SIZE }, (_, index) => BigInt(index + 1));
      const bets = amounts.map((units) => betCommand({ wallet, amount: unitAmount(units) }));
      const envelopes = bets.map((bet) => buildEnvelope({ data: toMessageData(bet) }));
      const app = await createTestApp({
        roles: ['consumer'],
        env: { DATABASE_URL: database.appUrl, ...queues.env },
      });
      try {
        await publishInOrder(app.sqs, queues.urls.wagerTransactions, envelopes, wallet.id);

        await waitFor(
          async () => (await processedCount(database.superuserUrl, [wallet.id])) === BATCH_SIZE,
          WAIT,
        );
        await waitFor(
          async () => (await countMessages(app.sqs, queues.urls.wagerTransactions)).total === 0,
          WAIT,
        );

        const applied = await snapshotsInProcessingOrder(database.superuserUrl, wallet.id);
        expect(applied.map((row) => row.external_transaction_id)).toEqual(
          bets.map((bet) => bet.body.externalTransactionId),
        );
        expect(applied.map((row) => row.balance_snapshot_amount)).toEqual(runningBalances(amounts));
      } finally {
        await app.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'holds the rest of the group back while the first message hits a transient error',
    async () => {
      const database = await createTestDatabase();
      const queues = await createTestQueues();
      const [locked, free] = await createWallets(database, 2);
      if (locked === undefined || free === undefined) {
        throw new TypeError('wallets were not created');
      }
      const groupId = randomUUID();
      const front = betCommand({ wallet: locked, amount: '50.00' });
      const amounts = Array.from({ length: BATCH_SIZE - 1 }, (_, index) => BigInt(index + 1));
      const followers = amounts.map((units) =>
        betCommand({ wallet: free, amount: unitAmount(units) }),
      );
      const envelopes = [front, ...followers].map((bet) =>
        buildEnvelope({ data: toMessageData(bet) }),
      );
      const logs = captureLogs();
      const lock = await holdWalletLock(database, locked.id);
      let lockHeld = true;
      const app = await createTestApp({
        roles: ['consumer'],
        env: { DATABASE_URL: database.appUrl, ...queues.env },
        logDestination: logs.destination,
      });
      try {
        await publishInOrder(app.sqs, queues.urls.wagerTransactions, envelopes, groupId);

        await waitFor(
          () =>
            logs
              .entries()
              .some(
                (entry) =>
                  entry.message === 'message processing deferred' &&
                  entry.reason === 'lock_timeout',
              ),
          WAIT,
        );
        expect(await processedCount(database.superuserUrl, [locked.id, free.id])).toBe(0);
        const held = await queryRows(
          database.superuserUrl,
          `select count(*)::int as transactions from wager_transactions
            where wallet_id = any($1::uuid[]) and kind = 'BET'`,
          [[locked.id, free.id]],
        );
        expect(held[0]?.transactions).toBe(0);

        await releaseWalletLock(lock);
        lockHeld = false;

        await waitFor(
          async () =>
            (await processedCount(database.superuserUrl, [locked.id, free.id])) === BATCH_SIZE,
          WAIT,
        );
        await waitFor(
          async () => (await countMessages(app.sqs, queues.urls.wagerTransactions)).total === 0,
          WAIT,
        );

        const order = await queryRows(
          database.superuserUrl,
          `select external_transaction_id from wager_transactions
            where wallet_id = any($1::uuid[]) and kind = 'BET'
            order by processed_at, id`,
          [[locked.id, free.id]],
        );
        expect(order.map((row) => row.external_transaction_id)).toEqual(
          [front, ...followers].map((bet) => bet.body.externalTransactionId),
        );
        const applied = await snapshotsInProcessingOrder(database.superuserUrl, free.id);
        expect(applied.map((row) => row.balance_snapshot_amount)).toEqual(runningBalances(amounts));
        expect((await countMessages(app.sqs, queues.urls.wagerTransactionsDlq)).total).toBe(0);
      } finally {
        if (lockHeld) {
          await releaseWalletLock(lock);
        }
        await app.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
