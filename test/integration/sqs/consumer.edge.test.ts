import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { SUBMISSION_CONSUMER } from '@application/services/submission-fast-path';
import { FailureCode } from '@domain/shared/failure-code';
import { DlqReason } from '@interfaces/sqs/dlq-mover';
import {
  betCommand,
  createWalletViaUseCase,
  submitViaApi,
  toMessageData,
} from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import {
  buildEnvelope,
  countMessages,
  publishBody,
  publishEnvelope,
  readDlq,
} from '@test/support/sqs';
import type { ReceivedTestMessage } from '@test/support/sqs';
import { createTestApp } from '@test/support/test-app';
import type { TestApp, TestAppRole } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

const WAIT = { timeoutMs: 30_000, intervalMs: 200 } as const;
const TEST_TIMEOUT_MS = 90_000;
const WRITE_TABLES = [
  'wager_transactions',
  'ledger_entries',
  'idempotency_records',
  'inbox_messages',
  'outbox_messages',
  'pending_reference_retries',
] as const;

interface ConsumerHarness {
  readonly database: TestDatabase;
  readonly app: TestApp;
  readonly wallet: TestWallet;
}

interface InvalidBodyInput {
  readonly label: string;
  readonly body: string;
}

interface InvalidBody extends InvalidBodyInput {
  readonly sqsMessageId: string;
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

const withConsumer = async (
  scenario: (harness: ConsumerHarness) => Promise<void>,
  roles: readonly TestAppRole[] = ['consumer'],
): Promise<void> => {
  const database = await createTestDatabase();
  const queues = await createTestQueues();
  const app = await createTestApp({
    roles,
    env: { DATABASE_URL: database.appUrl, ...queues.env },
  });
  try {
    const wallet = await createWalletViaUseCase(app);
    await scenario({ database, app, wallet });
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

const transactionRows = (databaseUrl: string, externalTransactionId: string) =>
  queryRows(
    databaseUrl,
    `select id, status, failure_code, correlation_id from wager_transactions
       where provider_id = $1 and external_transaction_id = $2`,
    [TEST_PROVIDER_ID, externalTransactionId],
  );

const walletBalance = async (databaseUrl: string, walletId: string): Promise<unknown> => {
  const rows = await queryRows(databaseUrl, 'select balance from wallets where id = $1', [
    walletId,
  ]);
  return rows[0]?.balance;
};

const balanceEventCount = async (databaseUrl: string, walletId: string): Promise<unknown> => {
  const rows = await queryRows(
    databaseUrl,
    `select count(*)::int as total from outbox_messages
       where event_type = 'WalletBalanceChanged' and aggregate_id = $1`,
    [walletId],
  );
  return rows[0]?.total;
};

const queueTotal = async (app: TestApp, queueUrl: string): Promise<number> =>
  (await countMessages(app.sqs, queueUrl)).total;

const waitForEmptyQueue = (app: TestApp): Promise<void> =>
  waitFor(async () => (await queueTotal(app, app.queueUrls.wagerTransactions)) === 0, WAIT);

const waitForDlq = async (app: TestApp, expected: number): Promise<ReceivedTestMessage[]> => {
  await waitFor(
    async () => (await queueTotal(app, app.queueUrls.wagerTransactionsDlq)) >= expected,
    WAIT,
  );
  await waitForEmptyQueue(app);
  const messages = await readDlq(app.sqs, app.queueUrls.wagerTransactionsDlq);
  expect(messages).toHaveLength(expected);
  return messages;
};

const waitForStatus = (
  databaseUrl: string,
  externalTransactionId: string,
  status: string,
): Promise<void> =>
  waitFor(async () => {
    const [row] = await transactionRows(databaseUrl, externalTransactionId);
    return row?.status === status;
  }, WAIT);

const publishInvalidBodies = async (
  app: TestApp,
  wallet: TestWallet,
  invalid: readonly InvalidBodyInput[],
): Promise<Map<string, InvalidBody>> => {
  const published = new Map<string, InvalidBody>();
  for (const entry of invalid) {
    const sqsMessageId = await publishBody(app.sqs, app.queueUrls.wagerTransactions, entry.body, {
      groupId: wallet.id,
      deduplicationId: randomUUID(),
    });
    published.set(entry.label, { ...entry, sqsMessageId });
  }
  return published;
};

const expectMovedAsInvalid = (
  moved: readonly ReceivedTestMessage[],
  invalid: ReadonlyMap<string, InvalidBody>,
  groupId: string,
  originalIdOf: (entry: InvalidBody) => string,
): void => {
  for (const entry of invalid.values()) {
    const message = moved.find((candidate) => candidate.body === entry.body);
    expect(message?.groupId).toBe(groupId);
    expect(message?.attributes).toEqual({
      dlqReason: DlqReason.InvalidPayload,
      originalMessageId: originalIdOf(entry),
    });
  }
};

describe('wager transaction consumer edge cases', () => {
  it(
    'treats a known messageId with another occurredAt or correlationId as a duplicate',
    () =>
      withConsumer(async ({ database, app, wallet }) => {
        const bet = betCommand({ wallet });
        const first = buildEnvelope({
          data: toMessageData(bet),
          occurredAt: '2026-07-29T15:00:00.000Z',
        });
        await publishEnvelope(app.sqs, app.queueUrls.wagerTransactions, first, {
          correlationId: 'corr-first',
        });
        await waitForStatus(database.superuserUrl, bet.body.externalTransactionId, 'PROCESSED');
        await waitForEmptyQueue(app);
        const afterFirst = await tableCounts(database.superuserUrl);

        const laterOccurrence = { ...first, occurredAt: '2026-07-29T18:30:00.000-03:00' };
        await publishEnvelope(app.sqs, app.queueUrls.wagerTransactions, laterOccurrence, {
          deduplicationId: randomUUID(),
          correlationId: 'corr-first',
        });
        await waitForEmptyQueue(app);
        await publishEnvelope(app.sqs, app.queueUrls.wagerTransactions, first, {
          deduplicationId: randomUUID(),
          correlationId: 'corr-second',
        });
        await waitForEmptyQueue(app);

        expect(await queueTotal(app, app.queueUrls.wagerTransactionsDlq)).toBe(0);
        expect(await tableCounts(database.superuserUrl)).toEqual(afterFirst);
        const transactions = await transactionRows(
          database.superuserUrl,
          bet.body.externalTransactionId,
        );
        expect(transactions).toHaveLength(1);
        expect(transactions[0]).toMatchObject({
          status: 'PROCESSED',
          correlation_id: 'corr-first',
        });
        expect(await walletBalance(database.superuserUrl, wallet.id)).toBe('990.00');
        const inbox = await queryRows(
          database.superuserUrl,
          `select count(*)::int as deliveries from inbox_messages
             where consumer_name = $1 and message_id = $2 and processed_at is not null`,
          [SUBMISSION_CONSUMER, first.messageId],
        );
        expect(inbox[0]?.deliveries).toBe(1);
      }),
    TEST_TIMEOUT_MS,
  );

  it(
    'moves envelopes with a wrong type, occurredAt, extra field or long messageId as INVALID_PAYLOAD',
    () =>
      withConsumer(async ({ database, app, wallet }) => {
        const before = await tableCounts(database.superuserUrl);
        const envelope = (): ReturnType<typeof buildEnvelope> =>
          buildEnvelope({ data: toMessageData(betCommand({ wallet })) });
        const wrongType = envelope();
        const invalidDate = envelope();
        const withoutOffset = envelope();
        const extraField = envelope();
        const longId = envelope();
        const invalid = await publishInvalidBodies(app, wallet, [
          {
            label: wrongType.messageId,
            body: JSON.stringify({ ...wrongType, type: 'WagerTransactionProcessed' }),
          },
          {
            label: invalidDate.messageId,
            body: JSON.stringify({ ...invalidDate, occurredAt: '2026-02-30T25:61:00.000Z' }),
          },
          {
            label: withoutOffset.messageId,
            body: JSON.stringify({ ...withoutOffset, occurredAt: '2026-07-29T15:00:00.000' }),
          },
          {
            label: extraField.messageId,
            body: JSON.stringify({ ...extraField, source: 'provider-a' }),
          },
          {
            label: 'long-message-id',
            body: JSON.stringify({ ...longId, messageId: 'm'.repeat(129) }),
          },
        ]);

        const moved = await waitForDlq(app, invalid.size);

        expectMovedAsInvalid(moved, invalid, wallet.id, (entry) =>
          entry.label === 'long-message-id' ? entry.sqsMessageId : entry.label,
        );
        expect(await tableCounts(database.superuserUrl)).toEqual(before);
      }),
    TEST_TIMEOUT_MS,
  );

  it(
    'moves a valid envelope carrying invalid data as INVALID_PAYLOAD',
    () =>
      withConsumer(async ({ database, app, wallet }) => {
        const before = await tableCounts(database.superuserUrl);
        const shortAmount = buildEnvelope({
          data: toMessageData(betCommand({ wallet, amount: '1.0' })),
        });
        const lowercaseCurrency = buildEnvelope({
          data: toMessageData(betCommand({ wallet, currency: 'brl' })),
        });
        const withoutKey = buildEnvelope({ data: toMessageData(betCommand({ wallet })) });
        const { idempotencyKey, ...dataWithoutKey } = withoutKey.data;
        expect(idempotencyKey).toBeDefined();
        const invalid = await publishInvalidBodies(app, wallet, [
          { label: shortAmount.messageId, body: JSON.stringify(shortAmount) },
          { label: lowercaseCurrency.messageId, body: JSON.stringify(lowercaseCurrency) },
          {
            label: withoutKey.messageId,
            body: JSON.stringify({ ...withoutKey, data: dataWithoutKey }),
          },
        ]);

        const moved = await waitForDlq(app, invalid.size);

        expectMovedAsInvalid(moved, invalid, wallet.id, (entry) => entry.label);
        expect(await tableCounts(database.superuserUrl)).toEqual(before);
      }),
    TEST_TIMEOUT_MS,
  );

  it(
    'acks a message for an unknown wallet with a 422 record, a processed inbox and no transaction',
    () =>
      withConsumer(async ({ database, app }) => {
        const before = await tableCounts(database.superuserUrl);
        const ghost = { id: randomUUID(), playerId: randomUUID() };
        const bet = betCommand({ wallet: ghost });
        const envelope = buildEnvelope({ data: toMessageData(bet) });
        await publishEnvelope(app.sqs, app.queueUrls.wagerTransactions, envelope);

        await waitFor(async () => {
          const rows = await queryRows(
            database.superuserUrl,
            'select 1 from idempotency_records where provider_id = $1 and idempotency_key = $2',
            [TEST_PROVIDER_ID, bet.idempotencyKey],
          );
          return rows.length === 1;
        }, WAIT);
        await waitForEmptyQueue(app);

        const records = await queryRows(
          database.superuserUrl,
          `select http_status, transaction_id, response_body ->> 'status' as status,
                  response_body ->> 'failureCode' as failure_code
             from idempotency_records where provider_id = $1 and idempotency_key = $2`,
          [TEST_PROVIDER_ID, bet.idempotencyKey],
        );
        expect(records).toEqual([
          {
            http_status: 422,
            transaction_id: null,
            status: 'REJECTED',
            failure_code: FailureCode.WalletNotFound,
          },
        ]);
        const inbox = await queryRows(
          database.superuserUrl,
          `select processed_at is not null as processed from inbox_messages
             where consumer_name = $1 and message_id = $2`,
          [SUBMISSION_CONSUMER, envelope.messageId],
        );
        expect(inbox).toEqual([{ processed: true }]);
        expect(
          await transactionRows(database.superuserUrl, bet.body.externalTransactionId),
        ).toEqual([]);
        expect(await queueTotal(app, app.queueUrls.wagerTransactionsDlq)).toBe(0);
        expect(await tableCounts(database.superuserUrl)).toEqual({
          ...before,
          idempotency_records: Number(before.idempotency_records) + 1,
          inbox_messages: Number(before.inbox_messages) + 1,
        });
      }),
    TEST_TIMEOUT_MS,
  );

  it(
    'acks business rejections from the queue as REJECTED with an event and nothing in the DLQ',
    () =>
      withConsumer(async ({ database, app, wallet }) => {
        const rejections = [
          {
            failureCode: FailureCode.InsufficientFunds,
            request: betCommand({ wallet, amount: '5000.00' }),
          },
          {
            failureCode: FailureCode.CurrencyMismatch,
            request: betCommand({ wallet, currency: 'USD' }),
          },
          {
            failureCode: FailureCode.PlayerWalletMismatch,
            request: betCommand({ wallet: { id: wallet.id, playerId: randomUUID() } }),
          },
        ] as const;
        const balanceEventsBefore = await balanceEventCount(database.superuserUrl, wallet.id);
        for (const { request } of rejections) {
          await publishEnvelope(
            app.sqs,
            app.queueUrls.wagerTransactions,
            buildEnvelope({ data: toMessageData(request) }),
          );
        }

        for (const { request } of rejections) {
          await waitForStatus(
            database.superuserUrl,
            request.body.externalTransactionId,
            'REJECTED',
          );
        }
        await waitForEmptyQueue(app);

        for (const { failureCode, request } of rejections) {
          const [transaction] = await transactionRows(
            database.superuserUrl,
            request.body.externalTransactionId,
          );
          expect(transaction).toMatchObject({ status: 'REJECTED', failure_code: failureCode });
          const events = await queryRows(
            database.superuserUrl,
            `select event_type, payload -> 'data' ->> 'failureCode' as failure_code
               from outbox_messages where payload -> 'data' ->> 'transactionId' = $1`,
            [transaction?.id],
          );
          expect(events).toEqual([
            { event_type: 'WagerTransactionRejected', failure_code: failureCode },
          ]);
          const records = await queryRows(
            database.superuserUrl,
            `select http_status from idempotency_records
               where provider_id = $1 and idempotency_key = $2`,
            [TEST_PROVIDER_ID, request.idempotencyKey],
          );
          expect(records).toEqual([{ http_status: 422 }]);
        }
        expect(await balanceEventCount(database.superuserUrl, wallet.id)).toBe(balanceEventsBefore);
        expect(await walletBalance(database.superuserUrl, wallet.id)).toBe('1000.00');
        expect(await queueTotal(app, app.queueUrls.wagerTransactionsDlq)).toBe(0);
      }),
    TEST_TIMEOUT_MS,
  );

  it(
    'moves a queue message that reuses an HTTP external id under another key as EXTERNAL_TRANSACTION_ID_CONFLICT',
    () =>
      withConsumer(
        async ({ database, app, wallet }) => {
          const token = await app.issuer.token({ role: 'provider', providerId: TEST_PROVIDER_ID });
          const overHttp = betCommand({ wallet });
          const response = await submitViaApi(app.baseUrl, token, overHttp);
          expect(response.status).toBe(200);
          const overQueue = { ...overHttp, idempotencyKey: `${overHttp.idempotencyKey}-queue` };
          const envelope = buildEnvelope({ data: toMessageData(overQueue) });
          await publishEnvelope(app.sqs, app.queueUrls.wagerTransactions, envelope);

          const [moved] = await waitForDlq(app, 1);

          expect(moved?.attributes).toEqual({
            dlqReason: DlqReason.ExternalTransactionIdConflict,
            failureCode: FailureCode.ExternalTransactionIdConflict,
            originalMessageId: envelope.messageId,
          });
          const transactions = await transactionRows(
            database.superuserUrl,
            overHttp.body.externalTransactionId,
          );
          expect(transactions).toHaveLength(1);
          expect(transactions[0]?.status).toBe('PROCESSED');
          expect(await walletBalance(database.superuserUrl, wallet.id)).toBe('990.00');
        },
        ['api', 'consumer'],
      ),
    TEST_TIMEOUT_MS,
  );

  it(
    'replays over HTTP a transaction first applied from the queue with the same key',
    () =>
      withConsumer(
        async ({ database, app, wallet }) => {
          const bet = betCommand({ wallet });
          const envelope = buildEnvelope({ data: toMessageData(bet) });
          await publishEnvelope(app.sqs, app.queueUrls.wagerTransactions, envelope);
          await waitForStatus(database.superuserUrl, bet.body.externalTransactionId, 'PROCESSED');
          await waitForEmptyQueue(app);
          const [applied] = await transactionRows(
            database.superuserUrl,
            bet.body.externalTransactionId,
          );

          const token = await app.issuer.token({ role: 'provider', providerId: TEST_PROVIDER_ID });
          const response = await submitViaApi(app.baseUrl, token, bet);

          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({
            transactionId: applied?.id,
            status: 'PROCESSED',
            idempotentReplay: true,
          });
          expect(
            await transactionRows(database.superuserUrl, bet.body.externalTransactionId),
          ).toHaveLength(1);
          expect(await walletBalance(database.superuserUrl, wallet.id)).toBe('990.00');
          expect(await queueTotal(app, app.queueUrls.wagerTransactionsDlq)).toBe(0);
        },
        ['api', 'consumer'],
      ),
    TEST_TIMEOUT_MS,
  );
});
