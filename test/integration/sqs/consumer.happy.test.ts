import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import type { SubmitWagerTransactionCommand } from '@application/commands/submit-wager-transaction.command';
import { computePayloadHash } from '@application/services/payload-hash';
import { SUBMISSION_CONSUMER } from '@application/services/submission-fast-path';
import { Sha256Hasher } from '@infrastructure/system/sha256-hasher';
import type { WagerTransactionRequest } from '@interfaces/http/schemas/wager-transaction.schema';
import { betCommand, createWalletViaUseCase, toMessageData } from '@test/support/fixtures';
import { buildEnvelope, countMessages, publishEnvelope } from '@test/support/sqs';
import { createTestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

const WAIT = { timeoutMs: 30_000, intervalMs: 100 } as const;
const TEST_TIMEOUT_MS = 60_000;
const SHA256_HEX = /^[0-9a-f]{64}$/;

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

const httpPayloadHash = (request: WagerTransactionRequest): string => {
  const command: SubmitWagerTransactionCommand = {
    channel: 'http',
    identity: {
      kind: 'provider',
      providerId: request.body.providerId,
      clientId: 'provider-client',
    },
    ...request.body,
    referenceExternalTransactionId: request.body.referenceExternalTransactionId,
    idempotencyKey: request.idempotencyKey,
    correlationId: 'http-correlation',
    causationId: 'http-correlation',
    inbox: undefined,
  };
  return computePayloadHash(command, new Sha256Hasher());
};

const transactionRows = (databaseUrl: string, externalTransactionId: string) =>
  queryRows(
    databaseUrl,
    `select id, status, payload_hash, balance_snapshot_amount, correlation_id
       from wager_transactions where provider_id = $1 and external_transaction_id = $2`,
    [TEST_PROVIDER_ID, externalTransactionId],
  );

describe('wager transaction consumer happy path', () => {
  it(
    'processes a BET from the queue, deletes the message and records the inbox',
    async () => {
      const database = await createTestDatabase();
      const queues = await createTestQueues();
      const app = await createTestApp({
        roles: ['consumer'],
        env: { DATABASE_URL: database.appUrl, ...queues.env },
      });
      try {
        const wallet = await createWalletViaUseCase(app);
        const bet = betCommand({ wallet, amount: '10.00' });
        const envelope = buildEnvelope({ data: toMessageData(bet) });
        await publishEnvelope(app.sqs, queues.urls.wagerTransactions, envelope, {
          correlationId: 'corr-happy',
        });

        await waitFor(async () => {
          const [row] = await transactionRows(
            database.superuserUrl,
            bet.body.externalTransactionId,
          );
          return row?.status === 'PROCESSED';
        }, WAIT);
        await waitFor(
          async () => (await countMessages(app.sqs, queues.urls.wagerTransactions)).total === 0,
          WAIT,
        );

        const transactions = await transactionRows(
          database.superuserUrl,
          bet.body.externalTransactionId,
        );
        expect(transactions).toHaveLength(1);
        expect(transactions[0]).toMatchObject({
          status: 'PROCESSED',
          balance_snapshot_amount: '990.00',
          correlation_id: 'corr-happy',
        });

        const wallets = await queryRows(
          database.superuserUrl,
          'select balance from wallets where id = $1',
          [wallet.id],
        );
        expect(wallets[0]?.balance).toBe('990.00');

        const postings = await queryRows(
          database.superuserUrl,
          'select count(*)::int as postings from ledger_entries where transaction_id = $1',
          [transactions[0]?.id],
        );
        expect(postings[0]?.postings).toBe(2);

        const inbox = await queryRows(
          database.superuserUrl,
          'select consumer_name, payload_hash, processed_at from inbox_messages where message_id = $1',
          [envelope.messageId],
        );
        expect(inbox).toHaveLength(1);
        expect(inbox[0]?.consumer_name).toBe(SUBMISSION_CONSUMER);
        expect(inbox[0]?.payload_hash).toMatch(SHA256_HEX);
        expect(inbox[0]?.processed_at).toBeInstanceOf(Date);

        const expectedHash = httpPayloadHash(bet);
        expect(transactions[0]?.payload_hash).toBe(expectedHash);
        const records = await queryRows(
          database.superuserUrl,
          `select payload_hash, http_status, transaction_id from idempotency_records
             where provider_id = $1 and idempotency_key = $2`,
          [TEST_PROVIDER_ID, bet.idempotencyKey],
        );
        expect(records).toEqual([
          { payload_hash: expectedHash, http_status: 200, transaction_id: transactions[0]?.id },
        ]);

        expect(await countMessages(app.sqs, queues.urls.wagerTransactionsDlq)).toEqual({
          visible: 0,
          inFlight: 0,
          total: 0,
        });
      } finally {
        await app.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'uses the envelope messageId as correlation id when the attribute is missing',
    async () => {
      const database = await createTestDatabase();
      const queues = await createTestQueues();
      const app = await createTestApp({
        roles: ['consumer'],
        env: { DATABASE_URL: database.appUrl, ...queues.env },
      });
      try {
        const wallet = await createWalletViaUseCase(app);
        const bet = betCommand({ wallet });
        const envelope = buildEnvelope({ data: toMessageData(bet) });
        await publishEnvelope(app.sqs, queues.urls.wagerTransactions, envelope);

        await waitFor(async () => {
          const [row] = await transactionRows(
            database.superuserUrl,
            bet.body.externalTransactionId,
          );
          return row?.status === 'PROCESSED';
        }, WAIT);
        const [row] = await transactionRows(database.superuserUrl, bet.body.externalTransactionId);
        expect(row?.correlation_id).toBe(envelope.messageId);
      } finally {
        await app.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
