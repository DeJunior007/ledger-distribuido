import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { FailureCode } from '@domain/shared/failure-code';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { DlqReason } from '@interfaces/sqs/dlq-mover';
import {
  breakLedgerWrites,
  breakOutboxWrites,
  restoreGrants,
} from '@test/support/deterministic-failure';
import { betCommand, createWalletViaUseCase, toMessageData } from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import {
  buildEnvelope,
  countMessages,
  publishBody,
  publishEnvelope,
  readDlq,
} from '@test/support/sqs';
import type { ReceivedTestMessage, WagerTransactionEnvelope } from '@test/support/sqs';
import { createTestApp } from '@test/support/test-app';
import type { TestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

const WAIT = { timeoutMs: 30_000, intervalMs: 200 } as const;
const FAILED_PATH_WAIT = { timeoutMs: 60_000, intervalMs: 250 } as const;
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
  const database = await createTestDatabase();
  const queues = await createTestQueues();
  const app = await createTestApp({
    roles: ['consumer'],
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
    `select status, failure_code from wager_transactions
       where provider_id = $1 and external_transaction_id = $2`,
    [TEST_PROVIDER_ID, externalTransactionId],
  );

const waitForDlq = async (
  app: TestApp,
  expected: number,
  options: { readonly timeoutMs: number; readonly intervalMs: number } = WAIT,
): Promise<ReceivedTestMessage[]> => {
  await waitFor(
    async () =>
      (await countMessages(app.sqs, app.queueUrls.wagerTransactionsDlq)).total >= expected,
    options,
  );
  await waitFor(
    async () => (await countMessages(app.sqs, app.queueUrls.wagerTransactions)).total === 0,
    options,
  );
  const messages = await readDlq(app.sqs, app.queueUrls.wagerTransactionsDlq);
  expect(messages).toHaveLength(expected);
  return messages;
};

const movedFor = (
  messages: readonly ReceivedTestMessage[],
  originalMessageId: string,
): ReceivedTestMessage => {
  const found = messages.find(
    (message) => message.attributes.originalMessageId === originalMessageId,
  );
  if (found === undefined) {
    throw new TypeError(`no dlq message for ${originalMessageId}`);
  }
  return found;
};

const waitForProcessed = (databaseUrl: string, externalTransactionId: string): Promise<void> =>
  waitFor(async () => {
    const [row] = await transactionRows(databaseUrl, externalTransactionId);
    return row?.status === 'PROCESSED';
  }, WAIT);

const withKind = (envelope: WagerTransactionEnvelope, kind: string): string =>
  JSON.stringify({ ...envelope, data: { ...envelope.data, kind } });

describe('wager transaction consumer dead letter queue', () => {
  it(
    'moves a body that is not an envelope with the SQS MessageId as originalMessageId',
    () =>
      withConsumer(async ({ database, app, wallet }) => {
        const before = await tableCounts(database.superuserUrl);
        const unreadable = await publishBody(app.sqs, app.queueUrls.wagerTransactions, 'not-json', {
          groupId: wallet.id,
          deduplicationId: randomUUID(),
        });
        const invalidType = buildEnvelope({ data: toMessageData(betCommand({ wallet })) });
        await publishBody(
          app.sqs,
          app.queueUrls.wagerTransactions,
          JSON.stringify({ ...invalidType, type: 'SomethingElse' }),
          { groupId: wallet.id, deduplicationId: randomUUID() },
        );

        const moved = await waitForDlq(app, 2);

        expect(movedFor(moved, unreadable).attributes).toEqual({
          dlqReason: DlqReason.InvalidPayload,
          originalMessageId: unreadable,
        });
        const readable = movedFor(moved, invalidType.messageId);
        expect(readable.attributes).toEqual({
          dlqReason: DlqReason.InvalidPayload,
          originalMessageId: invalidType.messageId,
        });
        expect(readable.groupId).toBe(wallet.id);
        expect(await tableCounts(database.superuserUrl)).toEqual(before);
      }),
    TEST_TIMEOUT_MS,
  );

  it(
    'moves the entries the queue reserves as INVALID_PAYLOAD and writes nothing',
    () =>
      withConsumer(async ({ database, app, wallet }) => {
        const before = await tableCounts(database.superuserUrl);
        const opening = buildEnvelope({ data: toMessageData(betCommand({ wallet })) });
        const systemProvider = buildEnvelope({
          data: toMessageData(betCommand({ wallet, providerId: '__system__' })),
        });
        const malformedProvider = buildEnvelope({
          data: toMessageData(betCommand({ wallet, providerId: 'Provider_A' })),
        });
        const selfReference = buildEnvelope({ data: toMessageData(betCommand({ wallet })) });
        const selfReferenceBody = JSON.stringify({
          ...selfReference,
          data: {
            ...selfReference.data,
            kind: WagerTransactionKind.Win,
            referenceExternalTransactionId: selfReference.data.externalTransactionId,
          },
        });
        const bodies: readonly (readonly [WagerTransactionEnvelope, string])[] = [
          [opening, withKind(opening, WagerTransactionKind.Opening)],
          [systemProvider, JSON.stringify(systemProvider)],
          [malformedProvider, JSON.stringify(malformedProvider)],
          [selfReference, selfReferenceBody],
        ];
        for (const [envelope, body] of bodies) {
          await publishBody(app.sqs, app.queueUrls.wagerTransactions, body, {
            groupId: wallet.id,
            deduplicationId: envelope.messageId,
          });
        }

        const moved = await waitForDlq(app, bodies.length);

        for (const [envelope, body] of bodies) {
          const message = movedFor(moved, envelope.messageId);
          expect(message.body).toBe(body);
          expect(message.attributes).toEqual({
            dlqReason: DlqReason.InvalidPayload,
            originalMessageId: envelope.messageId,
          });
        }
        expect(await tableCounts(database.superuserUrl)).toEqual(before);
      }),
    TEST_TIMEOUT_MS,
  );

  it(
    'moves a body with a repeated json key as INVALID_PAYLOAD and writes nothing',
    () =>
      withConsumer(async ({ database, app, wallet }) => {
        const before = await tableCounts(database.superuserUrl);
        const builders: readonly ((plain: string) => string)[] = [
          (plain) => `{"type":"WagerTransactionRequested",${plain.slice(1)}`,
          (plain) => plain.replace('"data":{', '"data":{"kind":"BET",'),
          (plain) => plain.replace('"money":{', '"money":{"currency":"BRL",'),
          (plain) => plain.replace('"data":{', '"data":{"\\u006bind":"BET",'),
        ];
        const bodies = builders.map((build) => {
          const envelope = buildEnvelope({ data: toMessageData(betCommand({ wallet })) });
          return [envelope, build(JSON.stringify(envelope))] as const;
        });
        for (const [envelope, body] of bodies) {
          expect(body).not.toBe(JSON.stringify(envelope));
          expect(JSON.parse(body)).toEqual(JSON.parse(JSON.stringify(envelope)));
          await publishBody(app.sqs, app.queueUrls.wagerTransactions, body, {
            groupId: wallet.id,
            deduplicationId: envelope.messageId,
          });
        }

        const moved = await waitForDlq(app, bodies.length);

        for (const [envelope, body] of bodies) {
          const message = movedFor(moved, envelope.messageId);
          expect(message.body).toBe(body);
          expect(message.attributes).toEqual({
            dlqReason: DlqReason.InvalidPayload,
            originalMessageId: envelope.messageId,
          });
        }
        expect(await tableCounts(database.superuserUrl)).toEqual(before);
      }),
    TEST_TIMEOUT_MS,
  );

  it(
    'moves a reused idempotency key with another payload as IDEMPOTENCY_KEY_CONFLICT',
    () =>
      withConsumer(async ({ database, app, wallet }) => {
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

        const [moved] = await waitForDlq(app, 1);

        expect(moved?.attributes).toEqual({
          dlqReason: DlqReason.IdempotencyKeyConflict,
          failureCode: FailureCode.IdempotencyKeyConflict,
          originalMessageId: second.messageId,
        });
        expect(moved?.body).toBe(JSON.stringify(second));
        await waitForProcessed(database.superuserUrl, original.body.externalTransactionId);
        expect(
          await transactionRows(database.superuserUrl, reused.body.externalTransactionId),
        ).toEqual([]);
      }),
    TEST_TIMEOUT_MS,
  );

  it(
    'moves a reused external transaction id as EXTERNAL_TRANSACTION_ID_CONFLICT and deletes its replay',
    () =>
      withConsumer(async ({ database, app, wallet }) => {
        const original = betCommand({ wallet });
        const reused = betCommand({
          wallet,
          amount: '20.00',
          externalTransactionId: original.body.externalTransactionId,
        });
        const first = buildEnvelope({ data: toMessageData(original) });
        const second = buildEnvelope({ data: toMessageData(reused) });
        await publishEnvelope(app.sqs, app.queueUrls.wagerTransactions, first);
        await publishEnvelope(app.sqs, app.queueUrls.wagerTransactions, second);

        const [moved] = await waitForDlq(app, 1);

        expect(moved?.attributes).toEqual({
          dlqReason: DlqReason.ExternalTransactionIdConflict,
          failureCode: FailureCode.ExternalTransactionIdConflict,
          originalMessageId: second.messageId,
        });
        const transactions = await transactionRows(
          database.superuserUrl,
          original.body.externalTransactionId,
        );
        expect(transactions).toEqual([{ status: 'PROCESSED', failure_code: null }]);
        const records = await queryRows(
          database.superuserUrl,
          `select r.http_status, r.transaction_id, r.response_body ->> 'transactionId' = t.id::text
                  as points_at_original
             from idempotency_records r
             join wager_transactions t on t.external_transaction_id = $2
            where r.idempotency_key = $1`,
          [reused.idempotencyKey, original.body.externalTransactionId],
        );
        expect(records).toEqual([
          { http_status: 409, transaction_id: null, points_at_original: true },
        ]);

        const replayed = buildEnvelope({ data: toMessageData(reused) });
        await publishEnvelope(app.sqs, app.queueUrls.wagerTransactions, replayed);
        await waitFor(
          async () => (await countMessages(app.sqs, app.queueUrls.wagerTransactions)).total === 0,
          WAIT,
        );
        expect((await countMessages(app.sqs, app.queueUrls.wagerTransactionsDlq)).total).toBe(1);
      }),
    TEST_TIMEOUT_MS,
  );

  it(
    'moves a known messageId carrying another payload as INBOX_PAYLOAD_MISMATCH',
    () =>
      withConsumer(async ({ database, app, wallet }) => {
        const original = betCommand({ wallet });
        const other = betCommand({ wallet, amount: '30.00' });
        const first = buildEnvelope({ data: toMessageData(original) });
        const second = buildEnvelope({
          messageId: first.messageId,
          data: toMessageData(other),
        });
        await publishEnvelope(app.sqs, app.queueUrls.wagerTransactions, first);
        await publishEnvelope(app.sqs, app.queueUrls.wagerTransactions, second, {
          deduplicationId: randomUUID(),
        });

        const [moved] = await waitForDlq(app, 1);

        expect(moved?.attributes).toEqual({
          dlqReason: DlqReason.InboxPayloadMismatch,
          originalMessageId: first.messageId,
        });
        expect(moved?.body).toBe(JSON.stringify(second));
        await waitForProcessed(database.superuserUrl, original.body.externalTransactionId);
        expect(
          await transactionRows(database.superuserUrl, other.body.externalTransactionId),
        ).toEqual([]);
        const inbox = await queryRows(
          database.superuserUrl,
          'select count(*)::int as deliveries from inbox_messages where message_id = $1',
          [first.messageId],
        );
        expect(inbox[0]?.deliveries).toBe(1);
      }),
    TEST_TIMEOUT_MS,
  );

  it(
    'records FAILED and moves the message as PROCESSING_FAILED on the last delivery',
    () =>
      withConsumer(async ({ database, app, wallet }) => {
        const bet = betCommand({ wallet });
        const envelope = buildEnvelope({ data: toMessageData(bet) });
        await breakLedgerWrites(database);
        try {
          await publishEnvelope(app.sqs, app.queueUrls.wagerTransactions, envelope);

          const [moved] = await waitForDlq(app, 1, FAILED_PATH_WAIT);

          const transactions = await transactionRows(
            database.superuserUrl,
            bet.body.externalTransactionId,
          );
          expect(transactions).toEqual([
            { status: 'FAILED', failure_code: FailureCode.ProcessingFailed },
          ]);
          expect(moved?.attributes).toEqual({
            dlqReason: DlqReason.ProcessingFailed,
            failureCode: FailureCode.ProcessingFailed,
            originalMessageId: envelope.messageId,
          });
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
    'moves the message as FAILED_PATH_ERROR and writes nothing when FAILED cannot be stored',
    () =>
      withConsumer(async ({ database, app, wallet }) => {
        const before = await tableCounts(database.superuserUrl);
        const envelope = buildEnvelope({ data: toMessageData(betCommand({ wallet })) });
        await breakLedgerWrites(database);
        await breakOutboxWrites(database);
        try {
          await publishEnvelope(app.sqs, app.queueUrls.wagerTransactions, envelope);

          const [moved] = await waitForDlq(app, 1, FAILED_PATH_WAIT);

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
