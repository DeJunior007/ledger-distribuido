import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { FailureCode } from '@domain/shared/failure-code';
import { DlqReason } from '@interfaces/sqs/dlq-mover';
import {
  breakLedgerWrites,
  breakOutboxWrites,
  restoreGrants,
} from '@test/support/deterministic-failure';
import { betCommand, createWalletViaUseCase, toMessageData } from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import { buildEnvelope, countMessages, publishEnvelope, readDlq } from '@test/support/sqs';
import type { ReceivedTestMessage } from '@test/support/sqs';
import { createTestApp } from '@test/support/test-app';
import type { TestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID } from '@test/support/test-issuer';
import { createTestQueues, testSqsClientConfig } from '@test/support/test-queues';
import type { TestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';
import { redriveDlq } from '../../../scripts/dlq-redrive';
import type { DlqRedriveConfig } from '../../../scripts/dlq-redrive';

const WAIT = { timeoutMs: 30_000, intervalMs: 200 } as const;
const FAILED_PATH_WAIT = { timeoutMs: 60_000, intervalMs: 250 } as const;
const TEST_TIMEOUT_MS = 150_000;

interface RedriveHarness {
  readonly database: TestDatabase;
  readonly queues: TestQueues;
  readonly app: TestApp;
  readonly wallet: TestWallet;
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

const startConsumer = (database: TestDatabase, queues: TestQueues): Promise<TestApp> =>
  createTestApp({
    roles: ['consumer'],
    env: { DATABASE_URL: database.appUrl, ...queues.env },
  });

const withConsumer = async (
  scenario: (harness: RedriveHarness) => Promise<void>,
): Promise<void> => {
  const database = await createTestDatabase();
  const queues = await createTestQueues();
  const app = await startConsumer(database, queues);
  try {
    const wallet = await createWalletViaUseCase(app);
    await scenario({ database, queues, app, wallet });
  } finally {
    await app.stop();
  }
};

const redriveConfig = (queues: TestQueues): DlqRedriveConfig => ({
  ...testSqsClientConfig(),
  WAGER_QUEUE_NAME: queues.names.wagerTransactions,
  WAGER_DLQ_NAME: queues.names.wagerTransactionsDlq,
});

const queueTotal = async (app: TestApp, queueUrl: string): Promise<number> =>
  (await countMessages(app.sqs, queueUrl)).total;

const waitForSettledDlq = async (
  app: TestApp,
  expected: number,
  options: { readonly timeoutMs: number; readonly intervalMs: number } = WAIT,
): Promise<ReceivedTestMessage[]> => {
  await waitFor(
    async () =>
      (await queueTotal(app, app.queueUrls.wagerTransactions)) === 0 &&
      (await queueTotal(app, app.queueUrls.wagerTransactionsDlq)) === expected,
    options,
  );
  const messages = await readDlq(app.sqs, app.queueUrls.wagerTransactionsDlq);
  expect(messages).toHaveLength(expected);
  return messages;
};

const transactionRows = (databaseUrl: string, externalTransactionId: string) =>
  queryRows(
    databaseUrl,
    `select id, status, failure_code from wager_transactions
       where provider_id = $1 and external_transaction_id = $2`,
    [TEST_PROVIDER_ID, externalTransactionId],
  );

const walletState = async (databaseUrl: string, walletId: string): Promise<unknown> => {
  const rows = await queryRows(
    databaseUrl,
    `select w.balance, (select count(*)::int from ledger_entries l where l.wallet_id = w.id)
            as postings
       from wallets w where w.id = $1`,
    [walletId],
  );
  return rows[0];
};

const idempotencyStatuses = (databaseUrl: string, idempotencyKey: string) =>
  queryRows(
    databaseUrl,
    `select http_status from idempotency_records where provider_id = $1 and idempotency_key = $2`,
    [TEST_PROVIDER_ID, idempotencyKey],
  );

describe('dlq redrive loop through the consumer', () => {
  it(
    'applies a FAILED_PATH_ERROR message once after the grants come back and it is redriven',
    () =>
      withConsumer(async ({ database, queues, app, wallet }) => {
        const bet = betCommand({ wallet });
        const envelope = buildEnvelope({ data: toMessageData(bet) });
        await breakLedgerWrites(database);
        await breakOutboxWrites(database);
        try {
          await publishEnvelope(app.sqs, app.queueUrls.wagerTransactions, envelope);
          const [moved] = await waitForSettledDlq(app, 1, FAILED_PATH_WAIT);
          expect(moved?.attributes).toEqual({
            dlqReason: DlqReason.FailedPathError,
            originalMessageId: envelope.messageId,
          });
        } finally {
          await restoreGrants(database);
        }
        expect(
          await transactionRows(database.superuserUrl, bet.body.externalTransactionId),
        ).toEqual([]);

        const summary = await redriveDlq(redriveConfig(queues), { force: false });

        expect(summary).toEqual({ redriven: 1, skipped: {}, errors: 0 });
        await waitFor(async () => {
          const [row] = await transactionRows(
            database.superuserUrl,
            bet.body.externalTransactionId,
          );
          return row?.status === 'PROCESSED';
        }, WAIT);
        await waitForSettledDlq(app, 0);
        const applied = await transactionRows(
          database.superuserUrl,
          bet.body.externalTransactionId,
        );
        expect(applied).toHaveLength(1);
        expect(applied[0]).toMatchObject({ status: 'PROCESSED', failure_code: null });
        expect(await walletState(database.superuserUrl, wallet.id)).toEqual({
          balance: '990.00',
          postings: 2,
        });
        const inbox = await queryRows(
          database.superuserUrl,
          `select count(*)::int as deliveries from inbox_messages
             where message_id = $1 and processed_at is not null`,
          [envelope.messageId],
        );
        expect(inbox[0]?.deliveries).toBe(1);
        expect(await idempotencyStatuses(database.superuserUrl, bet.idempotencyKey)).toEqual([
          { http_status: 200 },
        ]);
      }),
    TEST_TIMEOUT_MS,
  );

  it(
    'sends a forced IDEMPOTENCY_KEY_CONFLICT redriven while the consumer is stopped back to the DLQ without any effect',
    () =>
      withConsumer(async ({ database, queues, app, wallet }) => {
        const original = betCommand({ wallet });
        const reused = betCommand({
          wallet,
          amount: '20.00',
          idempotencyKey: original.idempotencyKey,
        });
        const first = buildEnvelope({ data: toMessageData(original) });
        const second = buildEnvelope({ data: toMessageData(reused) });
        await publishEnvelope(app.sqs, app.queueUrls.wagerTransactions, first);
        await publishEnvelope(app.sqs, app.queueUrls.wagerTransactions, second);
        await waitForSettledDlq(app, 1);
        const before = await walletState(database.superuserUrl, wallet.id);
        await app.stop();

        const summary = await redriveDlq(redriveConfig(queues), { force: true });

        expect(summary).toEqual({ redriven: 1, skipped: {}, errors: 0 });
        const restarted = await startConsumer(database, queues);
        const moved = await waitForSettledDlq(restarted, 1).then(
          async ([message]) => {
            await restarted.stop();
            return message;
          },
          async (reason: unknown) => {
            await restarted.stop();
            throw reason;
          },
        );
        expect(moved?.attributes).toEqual({
          dlqReason: DlqReason.IdempotencyKeyConflict,
          failureCode: FailureCode.IdempotencyKeyConflict,
          originalMessageId: second.messageId,
        });
        expect(moved?.body).toBe(JSON.stringify(second));
        expect(
          await transactionRows(database.superuserUrl, reused.body.externalTransactionId),
        ).toEqual([]);
        expect(await walletState(database.superuserUrl, wallet.id)).toEqual(before);
        expect(before).toEqual({ balance: '990.00', postings: 2 });
        expect(await idempotencyStatuses(database.superuserUrl, original.idempotencyKey)).toEqual([
          { http_status: 200 },
        ]);
        const inbox = await queryRows(
          database.superuserUrl,
          'select count(*)::int as deliveries from inbox_messages where message_id = $1',
          [second.messageId],
        );
        expect(inbox[0]?.deliveries).toBe(0);
      }),
    TEST_TIMEOUT_MS,
  );

  it(
    'acks a forced PROCESSING_FAILED redrive as a replay and keeps the transaction FAILED',
    () =>
      withConsumer(async ({ database, queues, app, wallet }) => {
        const bet = betCommand({ wallet });
        const envelope = buildEnvelope({ data: toMessageData(bet) });
        await breakLedgerWrites(database);
        try {
          await publishEnvelope(app.sqs, app.queueUrls.wagerTransactions, envelope);
          const [moved] = await waitForSettledDlq(app, 1, FAILED_PATH_WAIT);
          expect(moved?.attributes).toEqual({
            dlqReason: DlqReason.ProcessingFailed,
            failureCode: FailureCode.ProcessingFailed,
            originalMessageId: envelope.messageId,
          });
        } finally {
          await restoreGrants(database);
        }
        const [failed] = await transactionRows(
          database.superuserUrl,
          bet.body.externalTransactionId,
        );
        expect(failed).toMatchObject({
          status: 'FAILED',
          failure_code: FailureCode.ProcessingFailed,
        });
        const before = await walletState(database.superuserUrl, wallet.id);

        const summary = await redriveDlq(redriveConfig(queues), { force: true });

        expect(summary).toEqual({ redriven: 1, skipped: {}, errors: 0 });
        await waitForSettledDlq(app, 0);
        expect(
          await transactionRows(database.superuserUrl, bet.body.externalTransactionId),
        ).toEqual([
          { id: failed?.id, status: 'FAILED', failure_code: FailureCode.ProcessingFailed },
        ]);
        expect(await walletState(database.superuserUrl, wallet.id)).toEqual(before);
        expect(before).toEqual({ balance: '1000.00', postings: 1 });
        expect(await idempotencyStatuses(database.superuserUrl, bet.idempotencyKey)).toEqual([
          { http_status: 500 },
        ]);
        const inbox = await queryRows(
          database.superuserUrl,
          'select count(*)::int as deliveries from inbox_messages where message_id = $1',
          [envelope.messageId],
        );
        expect(inbox[0]?.deliveries).toBe(1);
      }),
    TEST_TIMEOUT_MS,
  );
});
