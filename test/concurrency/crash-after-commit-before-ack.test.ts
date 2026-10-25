import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { FAULT_KILL_EXIT_CODE, NO_FAULT_ENV, faultEnv } from '@test/support/fault-env';
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
import { TestIssuer } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

const CONSUMER_NAME = 'wager-transactions-consumer';
const WALLET_COUNT = 4;
const BETS_PER_WALLET = 2;
const BET_AMOUNT = '10.00';
const INITIAL_BALANCE = '1000.00';
const EXPECTED_BALANCE = '980.00';
const CRASH_TIMEOUT_MS = 30_000;
const DRAIN_WAIT = { timeoutMs: 90_000, intervalMs: 250 } as const;
const TEST_TIMEOUT_MS = 170_000;

interface InboxRow {
  readonly message_id: string;
  readonly payload_hash: string;
  readonly processed_at: string;
}

const metricValue = async (baseUrl: string, name: string, labels: string): Promise<number> => {
  const response = await fetch(`${baseUrl}/metrics`);
  const text = await response.text();
  const line = text.split('\n').find((candidate) => candidate.startsWith(`${name}{${labels}} `));
  return line === undefined ? 0 : Number(line.slice(line.lastIndexOf(' ') + 1));
};

const sumMetric = async (
  group: SpawnedInstances,
  name: string,
  labels: string,
): Promise<number> => {
  const values = await Promise.all(
    group.instances.map((instance) => metricValue(instance.baseUrl, name, labels)),
  );
  return values.reduce((total, value) => total + value, 0);
};

const readInbox = async (db: Client): Promise<InboxRow[]> => {
  const result = await db.query<InboxRow>(
    `SELECT message_id, payload_hash, processed_at::text AS processed_at
       FROM inbox_messages WHERE consumer_name = $1`,
    [CONSUMER_NAME],
  );
  return result.rows.sort((left, right) => (left.message_id < right.message_id ? -1 : 1));
};

const countRows = async (
  db: Client,
  sql: string,
  params: readonly unknown[] = [],
): Promise<number> => {
  const result = await db.query<{ total: string }>(sql, [...params]);
  return Number(result.rows[0]?.total ?? '0');
};

const envelopesFor = (wallets: readonly TestWallet[]): WagerTransactionEnvelope[] =>
  wallets.flatMap((wallet) =>
    Array.from({ length: BETS_PER_WALLET }, () =>
      buildEnvelope({ data: toMessageData(betCommand({ wallet, amount: BET_AMOUNT })) }),
    ),
  );

describe('crash after commit before ack', () => {
  it(
    'turns the redelivery of a committed message into a replay on another consumer and deletes it',
    async () => {
      const database = await createTestDatabase();
      const queues = await createTestQueues();
      const issuer = await TestIssuer.start();
      const env = { DATABASE_URL: database.appUrl, ...queues.env, ...issuer.authConfig };
      const sqs = createTestSqsClient();
      const db = new Client({ connectionString: database.appUrl });
      await db.connect();
      const groups: SpawnedInstances[] = [];
      try {
        const [apis, crashing] = await Promise.all([
          spawnInstances({ role: 'api', count: 1, env }),
          spawnInstances({
            role: 'consumer',
            count: 1,
            env: { ...env, ...faultEnv('consumer.after_commit_before_ack') },
          }),
        ]);
        groups.push(apis, crashing);
        const operatorToken = await issuer.token({ role: 'operator' });
        const wallets = await Promise.all(
          Array.from({ length: WALLET_COUNT }, () =>
            createWalletViaApi(apis.instance(0).baseUrl, operatorToken, {
              initialBalance: { amount: INITIAL_BALANCE, currency: 'BRL' },
            }),
          ),
        );
        const envelopes = envelopesFor(wallets);
        const externalIds = envelopes.map((envelope) => envelope.data.externalTransactionId);
        await Promise.all(
          envelopes.map((envelope) =>
            publishEnvelope(sqs, queues.urls.wagerTransactions, envelope),
          ),
        );

        expect(await crashing.instance(0).waitForExit(CRASH_TIMEOUT_MS)).toBe(FAULT_KILL_EXIT_CODE);
        const committedBeforeCrash = await readInbox(db);
        const committedCount = committedBeforeCrash.length;
        expect(committedCount).toBeGreaterThanOrEqual(1);
        expect(
          await countRows(
            db,
            `SELECT count(*)::text AS total FROM wager_transactions
              WHERE external_transaction_id = ANY($1)`,
            [externalIds],
          ),
        ).toBe(committedCount);

        const survivors = await spawnInstances({
          role: 'consumer',
          count: 2,
          env: { ...env, ...NO_FAULT_ENV },
        });
        groups.push(survivors);
        await waitFor(async () => {
          const pending = await countMessages(sqs, queues.urls.wagerTransactions);
          const processed = await countRows(
            db,
            `SELECT count(*)::text AS total FROM wager_transactions
              WHERE status = 'PROCESSED' AND external_transaction_id = ANY($1)`,
            [externalIds],
          );
          return pending.total === 0 && processed === envelopes.length;
        }, DRAIN_WAIT);

        const inbox = await readInbox(db);
        expect(inbox.map((row) => row.message_id)).toEqual(
          envelopes.map((envelope) => envelope.messageId).sort(),
        );
        expect(inbox.every((row) => row.processed_at.length > 0)).toBe(true);
        for (const before of committedBeforeCrash) {
          expect(inbox.find((row) => row.message_id === before.message_id)).toEqual(before);
        }

        const transactions = await db.query<{ external_transaction_id: string; status: string }>(
          `SELECT external_transaction_id, status FROM wager_transactions
            WHERE external_transaction_id = ANY($1)`,
          [externalIds],
        );
        expect(
          transactions.rows.map((row) => `${row.external_transaction_id}:${row.status}`).sort(),
        ).toEqual(externalIds.map((externalId) => `${externalId}:PROCESSED`).sort());
        const entriesPerTransaction = await db.query<{ total: string }>(
          `SELECT count(le.id)::text AS total
             FROM wager_transactions wt
             LEFT JOIN ledger_entries le ON le.transaction_id = wt.id
            WHERE wt.external_transaction_id = ANY($1)
            GROUP BY wt.id`,
          [externalIds],
        );
        expect(entriesPerTransaction.rows.map((row) => row.total)).toEqual(
          envelopes.map(() => '2'),
        );
        const debits = await countRows(
          db,
          `SELECT count(*)::text AS total FROM ledger_entries
            WHERE account_kind = 'WALLET' AND direction = 'DEBIT'`,
        );
        expect(debits).toBe(envelopes.length);
        const balances = await db.query<{ balance: string }>(
          `SELECT balance::text AS balance FROM wallets`,
        );
        expect(balances.rows).toEqual(wallets.map(() => ({ balance: EXPECTED_BALANCE })));

        expect(
          await sumMetric(
            survivors,
            'jungle_inbox_duplicates_total',
            `consumer="${CONSUMER_NAME}"`,
          ),
        ).toBe(committedCount);
        expect(
          await sumMetric(survivors, 'jungle_idempotency_replays_total', 'channel="sqs"'),
        ).toBe(committedCount);
        expect((await countMessages(sqs, queues.urls.wagerTransactionsDlq)).total).toBe(0);
        expect((await countMessages(sqs, queues.urls.wagerTransactions)).total).toBe(0);
      } finally {
        await Promise.all(groups.map((group) => group.stop()));
        await db.end();
        sqs.destroy();
        await issuer.stop();
      }
    },
    { timeout: TEST_TIMEOUT_MS },
  );
});
