import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { DlqReason } from '@interfaces/sqs/dlq-mover';
import { betCommand, createWalletViaUseCase, toMessageData } from '@test/support/fixtures';
import { buildEnvelope, countMessages, publishBody, readDlq } from '@test/support/sqs';
import { createTestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

const NUMERIC_AMOUNT = 25;
const DLQ_WAIT = { timeoutMs: 30_000, intervalMs: 200 } as const;
const FORBIDDEN_TYPES = ['real', 'double precision', 'money'] as const;
const VALUE_COLUMNS = [
  'ledger_entries.amount numeric(20,2)',
  'ledger_entries.balance_after numeric(20,2)',
  'ledger_entries.balance_before numeric(20,2)',
  'reconciliation_runs.calculated_amount numeric(32,2)',
  'reconciliation_runs.difference_amount numeric(32,2)',
  'reconciliation_runs.stored_amount numeric(32,2)',
  'wager_transactions.amount numeric(20,2)',
  'wager_transactions.balance_snapshot_amount numeric(20,2)',
  'wallet_ledger_entries.amount numeric(20,2)',
  'wallet_ledger_entries.balance_after numeric(20,2)',
  'wallet_ledger_entries.balance_before numeric(20,2)',
  'wallets.balance numeric(20,2)',
] as const;

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

const transactionCount = async (databaseUrl: string): Promise<unknown> =>
  (
    await queryRows(
      databaseUrl,
      "SELECT count(*)::int AS total FROM wager_transactions WHERE kind <> 'OPENING'",
    )
  )[0]?.total;

describe('§5.1 dinheiro nunca é number', () => {
  it('answers 400 INVALID_MONEY over http and moves the message as INVALID_PAYLOAD over sqs', async () => {
    const database = await createTestDatabase();
    const queues = await createTestQueues();
    const app = await createTestApp({
      roles: ['api', 'consumer'],
      env: { DATABASE_URL: database.appUrl, ...queues.env },
    });
    try {
      const wallet = await createWalletViaUseCase(app);
      const providerToken = await app.issuer.token({
        role: 'provider',
        providerId: TEST_PROVIDER_ID,
      });
      const request = betCommand({ wallet });

      const response = await fetch(`${app.baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${providerToken}`,
          'Idempotency-Key': request.idempotencyKey,
        },
        body: JSON.stringify({
          ...request.body,
          money: { amount: NUMERIC_AMOUNT, currency: 'BRL' },
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ status: 400, failureCode: 'INVALID_MONEY' });

      const envelope = buildEnvelope({ data: toMessageData(betCommand({ wallet })) });
      const body = JSON.stringify({
        ...envelope,
        data: { ...envelope.data, money: { amount: NUMERIC_AMOUNT, currency: 'BRL' } },
      });
      await publishBody(app.sqs, app.queueUrls.wagerTransactions, body, {
        groupId: wallet.id,
        deduplicationId: envelope.messageId,
      });
      await waitFor(
        async () => (await countMessages(app.sqs, app.queueUrls.wagerTransactionsDlq)).total === 1,
        DLQ_WAIT,
      );
      const moved = await readDlq(app.sqs, app.queueUrls.wagerTransactionsDlq);

      expect(
        moved.map((message) => ({ body: message.body, attributes: message.attributes })),
      ).toEqual([
        {
          body,
          attributes: {
            dlqReason: DlqReason.InvalidPayload,
            originalMessageId: envelope.messageId,
          },
        },
      ]);
      expect(await transactionCount(database.superuserUrl)).toBe(0);
    } finally {
      await app.stop();
    }
  });

  it('stores every value column as numeric with two decimals and never as a float or money', async () => {
    const database = await createTestDatabase();

    const forbidden = await queryRows(
      database.superuserUrl,
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type = ANY($1::text[])`,
      [FORBIDDEN_TYPES],
    );
    const valueColumns = await queryRows(
      database.superuserUrl,
      `SELECT format('%s.%s numeric(%s,%s)', table_name, column_name,
                     numeric_precision, numeric_scale) AS definition
         FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type = 'numeric'
        ORDER BY table_name, column_name`,
    );

    expect(forbidden).toEqual([]);
    expect(valueColumns.map((column) => column.definition)).toEqual([...VALUE_COLUMNS]);
  });
});
