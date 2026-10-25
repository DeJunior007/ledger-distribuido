import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import type { DestinationStream } from 'pino';
import { ErrorClass } from '@application/errors/error-class';
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
import { TEST_MAX_RECEIVE_COUNT, createTestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

const FAILED_PATH_WAIT = { timeoutMs: 90_000, intervalMs: 250 } as const;
const TEST_TIMEOUT_MS = 150_000;
const WRITE_TABLES = [
  'wager_transactions',
  'ledger_entries',
  'idempotency_records',
  'inbox_messages',
  'outbox_messages',
  'pending_reference_retries',
] as const;

type LogEntry = Readonly<Record<string, unknown>>;

interface ConsumerHarness {
  readonly database: TestDatabase;
  readonly app: TestApp;
  readonly wallet: TestWallet;
  readonly logs: () => readonly LogEntry[];
}

const isRecord = (value: unknown): value is LogEntry =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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

const withConsumer = async (
  scenario: (harness: ConsumerHarness) => Promise<void>,
): Promise<void> => {
  const lines: string[] = [];
  const destination: DestinationStream = {
    write(chunk: string): void {
      lines.push(chunk);
    },
  };
  const database = await createTestDatabase();
  const queues = await createTestQueues();
  const app = await createTestApp({
    roles: ['consumer'],
    env: { DATABASE_URL: database.appUrl, ...queues.env },
    logDestination: destination,
  });
  const logs = (): readonly LogEntry[] =>
    lines.flatMap((line) => {
      const parsed: unknown = JSON.parse(line);
      return isRecord(parsed) ? [parsed] : [];
    });
  try {
    const wallet = await createWalletViaUseCase(app);
    await scenario({ database, app, wallet, logs });
  } finally {
    await app.stop();
  }
};

const tableCounts = async (databaseUrl: string): Promise<Record<string, unknown>> => {
  const counts: Record<string, unknown> = {};
  for (const table of WRITE_TABLES) {
    const rows = await queryRows(databaseUrl, `select count(*)::int as total from ${table}`);
    counts[table] = rows[0]?.total;
  }
  return counts;
};

const waitForSingleDlqMessage = async (app: TestApp): Promise<ReceivedTestMessage | undefined> => {
  await waitFor(
    async () => (await countMessages(app.sqs, app.queueUrls.wagerTransactionsDlq)).total >= 1,
    FAILED_PATH_WAIT,
  );
  await waitFor(
    async () => (await countMessages(app.sqs, app.queueUrls.wagerTransactions)).total === 0,
    FAILED_PATH_WAIT,
  );
  const messages = await readDlq(app.sqs, app.queueUrls.wagerTransactionsDlq);
  expect(messages).toHaveLength(1);
  return messages[0];
};

const deterministicAttempts = (logs: readonly LogEntry[], messageId: string): unknown[] =>
  logs
    .filter(
      (entry) =>
        entry.message === 'message processing deferred' &&
        entry.messageId === messageId &&
        entry.errorClass === ErrorClass.Deterministic,
    )
    .map((entry) => entry.attempt);

const retriedAttempts = Array.from({ length: TEST_MAX_RECEIVE_COUNT - 1 }, (_, index) => index + 1);

describe('wager transaction consumer retries', () => {
  it(
    'retries a deterministic error until the last delivery, then records FAILED and moves it as PROCESSING_FAILED',
    () =>
      withConsumer(async ({ database, app, wallet, logs }) => {
        const bet = betCommand({ wallet });
        const envelope = buildEnvelope({ data: toMessageData(bet) });
        await breakLedgerWrites(database);
        try {
          await publishEnvelope(app.sqs, app.queueUrls.wagerTransactions, envelope);

          const moved = await waitForSingleDlqMessage(app);

          expect(deterministicAttempts(logs(), envelope.messageId)).toEqual(retriedAttempts);
          expect(moved?.attributes).toEqual({
            dlqReason: DlqReason.ProcessingFailed,
            failureCode: FailureCode.ProcessingFailed,
            originalMessageId: envelope.messageId,
          });
          const transactions = await queryRows(
            database.superuserUrl,
            `select status, failure_code from wager_transactions
              where provider_id = $1 and external_transaction_id = $2`,
            [TEST_PROVIDER_ID, bet.body.externalTransactionId],
          );
          expect(transactions).toEqual([
            { status: 'FAILED', failure_code: FailureCode.ProcessingFailed },
          ]);
          const postings = await queryRows(
            database.superuserUrl,
            'select count(*)::int as postings from ledger_entries where wallet_id = $1',
            [wallet.id],
          );
          expect(postings[0]?.postings).toBe(1);
        } finally {
          await restoreGrants(database);
        }
      }),
    TEST_TIMEOUT_MS,
  );

  it(
    'moves the message as FAILED_PATH_ERROR on the last delivery when FAILED cannot be stored',
    () =>
      withConsumer(async ({ database, app, wallet, logs }) => {
        const before = await tableCounts(database.superuserUrl);
        const envelope = buildEnvelope({ data: toMessageData(betCommand({ wallet })) });
        await breakLedgerWrites(database);
        await breakOutboxWrites(database);
        try {
          await publishEnvelope(app.sqs, app.queueUrls.wagerTransactions, envelope);

          const moved = await waitForSingleDlqMessage(app);

          expect(deterministicAttempts(logs(), envelope.messageId)).toEqual(retriedAttempts);
          const failedPath = logs().filter(
            (entry) =>
              entry.message === 'failed path raised an error' &&
              entry.messageId === envelope.messageId,
          );
          expect(failedPath).toHaveLength(1);
          expect(failedPath[0]).toMatchObject({
            dlqReason: DlqReason.FailedPathError,
            attempt: TEST_MAX_RECEIVE_COUNT,
          });
          expect(moved?.attributes).toEqual({
            dlqReason: DlqReason.FailedPathError,
            originalMessageId: envelope.messageId,
          });
          expect(await tableCounts(database.superuserUrl)).toEqual(before);
        } finally {
          await restoreGrants(database);
        }
      }),
    TEST_TIMEOUT_MS,
  );
});
