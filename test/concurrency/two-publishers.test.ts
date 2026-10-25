import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { NO_FAULT_ENV } from '@test/support/fault-env';
import { betCommand, createWalletViaApi, submitViaApi } from '@test/support/fixtures';
import type { WagerTransactionRequest } from '@interfaces/http/schemas/wager-transaction.schema';
import { SIGKILL_EXIT_CODE, spawnInstances } from '@test/support/spawn-instances';
import type { SpawnedInstances } from '@test/support/spawn-instances';
import { countMessages, createTestSqsClient } from '@test/support/sqs';
import { createTestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID, TestIssuer } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

const AUDIT_CONSUMER = 'wallet-events-audit';
const EVENT_COUNT = 500;
const EVENTS_PER_OPERATION = 2;
const WALLET_COUNT = 10;
const BETS_PER_WALLET = EVENT_COUNT / EVENTS_PER_OPERATION / WALLET_COUNT - 1;
const BET_AMOUNT = '10.00';
const INITIAL_BALANCE = '1000.00';
const EXPECTED_BALANCE = '760.00';
const KILL_AFTER_PUBLISHED = 150;
const UNAVAILABLE_STATUS = 503;
const SUBMIT_RETRY = { timeoutMs: 60_000, intervalMs: 5_000 } as const;
const KILL_WAIT = { timeoutMs: 120_000, intervalMs: 5 } as const;
const DRAIN_WAIT = { timeoutMs: 120_000, intervalMs: 250 } as const;
const TEST_TIMEOUT_MS = 175_000;

interface OutboxProgress {
  readonly total: number;
  readonly published: number;
  readonly leasedByVictim: number;
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

const readProgress = async (db: Client, victimId: string): Promise<OutboxProgress> => {
  const result = await db.query<{ total: string; published: string; leased: string }>(
    `SELECT count(*)::text AS total,
            count(published_at)::text AS published,
            count(*) FILTER (
              WHERE locked_by = $1 AND published_at IS NULL AND locked_until > now()
            )::text AS leased
       FROM outbox_messages`,
    [victimId],
  );
  const row = result.rows[0];
  return {
    total: Number(row?.total ?? '0'),
    published: Number(row?.published ?? '0'),
    leasedByVictim: Number(row?.leased ?? '0'),
  };
};

const countUnpublishedHeldBy = async (db: Client, instanceId: string): Promise<number> => {
  const result = await db.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM outbox_messages
      WHERE locked_by = $1 AND published_at IS NULL`,
    [instanceId],
  );
  return Number(result.rows[0]?.total ?? '0');
};

const sortedIds = async (
  db: Client,
  sql: string,
  params: readonly unknown[],
): Promise<string[]> => {
  const result = await db.query<{ id: string }>(sql, [...params]);
  return result.rows.map((row) => row.id).sort();
};

const submitUntilSettled = async (
  baseUrl: string,
  providerToken: string,
  request: WagerTransactionRequest,
): Promise<number> => {
  let status = UNAVAILABLE_STATUS;
  await waitFor(async () => {
    const response = await submitViaApi(baseUrl, providerToken, request);
    await response.arrayBuffer();
    status = response.status;
    return status !== UNAVAILABLE_STATUS;
  }, SUBMIT_RETRY);
  return status;
};

describe('two outbox publishers', () => {
  it(
    'publishes every event once to the audit when one of two publishers dies mid-run',
    async () => {
      const database = await createTestDatabase();
      const queues = await createTestQueues();
      const issuer = await TestIssuer.start();
      const env = {
        DATABASE_URL: database.appUrl,
        ...queues.env,
        ...issuer.authConfig,
        ...NO_FAULT_ENV,
      };
      const sqs = createTestSqsClient();
      const db = new Client({ connectionString: database.appUrl });
      await db.connect();
      const groups: SpawnedInstances[] = [];
      try {
        const [apis, publishers, audits] = await Promise.all([
          spawnInstances({ role: 'api', count: 3, env }),
          spawnInstances({ role: 'outbox', count: 2, env }),
          spawnInstances({ role: 'events-audit', count: 1, env }),
        ]);
        groups.push(apis, publishers, audits);
        const victim = publishers.instance(1);
        const survivor = publishers.instance(0);
        const apiUrl = (index: number): string =>
          apis.instance(index % apis.instances.length).baseUrl;
        const operatorToken = await issuer.token({ role: 'operator' });
        const providerToken = await issuer.token({
          role: 'provider',
          providerId: TEST_PROVIDER_ID,
        });

        const wallets = await Promise.all(
          Array.from({ length: WALLET_COUNT }, (_, index) =>
            createWalletViaApi(apiUrl(index), operatorToken, {
              initialBalance: { amount: INITIAL_BALANCE, currency: 'BRL' },
            }),
          ),
        );
        const bets = wallets.flatMap((wallet) =>
          Array.from({ length: BETS_PER_WALLET }, () => betCommand({ wallet, amount: BET_AMOUNT })),
        );
        const killMidRun = async (): Promise<{ exitCode: number; leftLeased: number }> => {
          await waitFor(async () => {
            const progress = await readProgress(db, victim.instanceId);
            if (progress.published < KILL_AFTER_PUBLISHED || progress.leasedByVictim === 0) {
              return false;
            }
            process.kill(victim.pid, 'SIGSTOP');
            const frozen = await readProgress(db, victim.instanceId);
            if (frozen.leasedByVictim > 0) {
              return true;
            }
            process.kill(victim.pid, 'SIGCONT');
            return false;
          }, KILL_WAIT);
          const exitCode = await victim.kill('SIGKILL');
          return { exitCode, leftLeased: await countUnpublishedHeldBy(db, victim.instanceId) };
        };
        const [statuses, killed] = await Promise.all([
          Promise.all(
            bets.map((bet, index) => submitUntilSettled(apiUrl(index), providerToken, bet)),
          ),
          killMidRun(),
        ]);
        expect(killed.exitCode).toBe(SIGKILL_EXIT_CODE);
        expect(statuses).toEqual(bets.map(() => 200));
        const leftLeasedByVictim = killed.leftLeased;
        expect(leftLeasedByVictim).toBeGreaterThan(0);

        await waitFor(async () => {
          const progress = await readProgress(db, victim.instanceId);
          const audited = await db.query<{ total: string }>(
            `SELECT count(*)::text AS total FROM inbox_messages WHERE consumer_name = $1`,
            [AUDIT_CONSUMER],
          );
          const inQueue = await countMessages(sqs, queues.urls.walletEvents);
          return (
            progress.total === EVENT_COUNT &&
            progress.published === EVENT_COUNT &&
            Number(audited.rows[0]?.total ?? '0') === EVENT_COUNT &&
            inQueue.total === 0
          );
        }, DRAIN_WAIT);

        expect(survivor.running).toBe(true);
        expect(await countUnpublishedHeldBy(db, victim.instanceId)).toBe(0);
        const outboxIds = await sortedIds(db, `SELECT id::text AS id FROM outbox_messages`, []);
        const auditedIds = await sortedIds(
          db,
          `SELECT message_id AS id FROM inbox_messages
            WHERE consumer_name = $1 AND processed_at IS NOT NULL`,
          [AUDIT_CONSUMER],
        );
        expect(new Set(auditedIds).size).toBe(EVENT_COUNT);
        expect(auditedIds).toEqual(outboxIds);
        const duplicates = await sumMetric(
          audits,
          'jungle_inbox_duplicates_total',
          `consumer="${AUDIT_CONSUMER}"`,
        );
        expect(duplicates).toBeGreaterThanOrEqual(0);
        expect(duplicates).toBeLessThanOrEqual(leftLeasedByVictim);
        expect(
          await sumMetric(
            audits,
            'jungle_inbox_payload_mismatch_total',
            `consumer="${AUDIT_CONSUMER}"`,
          ),
        ).toBe(0);
        const balances = await db.query<{ balance: string }>(
          `SELECT balance::text AS balance FROM wallets`,
        );
        expect(balances.rows).toEqual(wallets.map(() => ({ balance: EXPECTED_BALANCE })));
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
