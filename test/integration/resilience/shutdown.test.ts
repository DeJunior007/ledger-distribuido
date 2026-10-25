import { afterEach, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import type { QueryResultRow } from 'pg';
import { pause, unpause } from '@test/support/containers';
import {
  betCommand,
  createWalletViaApi,
  refundCommand,
  submitViaApi,
  toMessageData,
} from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import { SIGTERM_EXIT_CODE, spawnInstances } from '@test/support/spawn-instances';
import type {
  InstanceRole,
  SpawnedInstance,
  SpawnedInstances,
} from '@test/support/spawn-instances';
import {
  buildEnvelope,
  countMessages,
  createTestSqsClient,
  publishEnvelope,
} from '@test/support/sqs';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID, TestIssuer } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';
import type { TestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

const WAIT = { timeoutMs: 45_000, intervalMs: 100 } as const;
const SIGTERM_TIMEOUT_MS = 30_000;
const STOP_GRACE_PERIOD_MS = 15_000;
const WORK_RELEASE_DELAY_MS = 500;
const AUDIT_CONSUMER = 'wallet-events-audit';
const WAGER_CONSUMER = 'wager-transactions-consumer';

interface Scenario {
  readonly database: TestDatabase;
  readonly queues: TestQueues;
  readonly issuer: TestIssuer;
  readonly env: Readonly<Record<string, string>>;
  readonly groups: SpawnedInstances[];
}

interface Shutdown {
  readonly exitCode: number;
  readonly elapsedMs: number;
}

const query = async <Row extends QueryResultRow>(
  databaseUrl: string,
  sql: string,
  params: readonly unknown[] = [],
): Promise<Row[]> => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<Row>(sql, [...params]);
    return result.rows;
  } finally {
    await client.end();
  }
};

const countOf = async (
  databaseUrl: string,
  sql: string,
  params: readonly unknown[] = [],
): Promise<number> => {
  const rows = await query<{ total: number }>(databaseUrl, sql, params);
  return rows[0]?.total ?? 0;
};

const openHolders = new Set<LockHolder>();

class LockHolder {
  private constructor(private readonly client: Client) {}

  static async begin(databaseUrl: string): Promise<LockHolder> {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const holder = new LockHolder(client);
    openHolders.add(holder);
    await client.query('begin');
    return holder;
  }

  async run(sql: string, params: readonly unknown[]): Promise<void> {
    await this.client.query(sql, [...params]);
  }

  async release(): Promise<void> {
    if (!openHolders.delete(this)) {
      return;
    }
    try {
      await this.client.query('rollback');
    } finally {
      await this.client.end();
    }
  }
}

const lockWallet = async (databaseUrl: string, walletId: string): Promise<LockHolder> => {
  const holder = await LockHolder.begin(databaseUrl);
  await holder.run('select id from wallets where id = $1 for update', [walletId]);
  return holder;
};

const lockWaiters = (databaseUrl: string): Promise<number> =>
  countOf(
    databaseUrl,
    `select count(*)::int as total from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`,
  );

const waitForLockWaiter = (databaseUrl: string): Promise<void> =>
  waitFor(async () => (await lockWaiters(databaseUrl)) > 0, { timeoutMs: 30_000, intervalMs: 50 });

const sigterm = async (instance: SpawnedInstance): Promise<Shutdown> => {
  const startedAt = performance.now();
  const exitCode = await instance.kill('SIGTERM', SIGTERM_TIMEOUT_MS);
  return { exitCode, elapsedMs: performance.now() - startedAt };
};

const transactionsOf = (databaseUrl: string, externalTransactionId: string) =>
  query<{ id: string; status: string }>(
    databaseUrl,
    'select id, status from wager_transactions where provider_id = $1 and external_transaction_id = $2',
    [TEST_PROVIDER_ID, externalTransactionId],
  );

const entriesOf = (databaseUrl: string, externalTransactionId: string): Promise<number> =>
  countOf(
    databaseUrl,
    `select count(*)::int as total from ledger_entries le
       join wager_transactions wt on wt.id = le.transaction_id
      where wt.provider_id = $1 and wt.external_transaction_id = $2`,
    [TEST_PROVIDER_ID, externalTransactionId],
  );

const balanceOf = async (databaseUrl: string, walletId: string): Promise<string | undefined> => {
  const rows = await query<{ balance: string }>(
    databaseUrl,
    'select balance::text as balance from wallets where id = $1',
    [walletId],
  );
  return rows[0]?.balance;
};

const outboxIds = async (databaseUrl: string): Promise<string[]> => {
  const rows = await query<{ id: string }>(databaseUrl, 'select id from outbox_messages');
  return rows.map((row) => row.id);
};

const unpublishedOutbox = (databaseUrl: string): Promise<number> =>
  countOf(
    databaseUrl,
    'select count(*)::int as total from outbox_messages where published_at is null',
  );

const claimedOutbox = (databaseUrl: string): Promise<number> =>
  countOf(
    databaseUrl,
    `select count(*)::int as total from outbox_messages
      where published_at is null and locked_by is not null`,
  );

const auditedEvents = (databaseUrl: string): Promise<number> =>
  countOf(
    databaseUrl,
    `select count(*)::int as total from inbox_messages
      where consumer_name = $1 and processed_at is not null`,
    [AUDIT_CONSUMER],
  );

const releaseLeases = async (databaseUrl: string): Promise<void> => {
  await query(
    databaseUrl,
    `update outbox_messages set locked_until = null, locked_by = null
      where published_at is null`,
  );
  await query(
    databaseUrl,
    `update pending_reference_retries set locked_until = null, locked_by = null
      where resolved_at is null`,
  );
};

const prepareScenario = async (): Promise<Scenario> => {
  const database = await createTestDatabase();
  const queues = await createTestQueues();
  const issuer = await TestIssuer.start();
  return {
    database,
    queues,
    issuer,
    env: { DATABASE_URL: database.appUrl, ...queues.env, ...issuer.authConfig },
    groups: [],
  };
};

const spawnRole = async (scenario: Scenario, role: InstanceRole): Promise<SpawnedInstance> => {
  const group = await spawnInstances({ role, count: 1, env: scenario.env });
  scenario.groups.push(group);
  return group.instance(0);
};

const finish = async (scenario: Scenario): Promise<void> => {
  await Promise.all(scenario.groups.map((group) => group.stop()));
  await scenario.issuer.stop();
};

const prepareWallet = async (scenario: Scenario, api: SpawnedInstance): Promise<TestWallet> =>
  createWalletViaApi(api.baseUrl, await scenario.issuer.token({ role: 'operator' }));

const providerToken = (scenario: Scenario): Promise<string> =>
  scenario.issuer.token({ role: 'provider', providerId: TEST_PROVIDER_ID });

const expectGracefulExit = (shutdown: Shutdown): void => {
  expect(shutdown.exitCode).toBe(SIGTERM_EXIT_CODE);
  expect(shutdown.elapsedMs).toBeLessThan(STOP_GRACE_PERIOD_MS);
};

const waitUntilOutboxDrained = (databaseUrl: string): Promise<void> =>
  waitFor(async () => (await unpublishedOutbox(databaseUrl)) === 0, WAIT);

describe('graceful shutdown', () => {
  let current: TestDatabase | undefined;

  afterEach(async () => {
    await Promise.all([...openHolders].map((holder) => holder.release()));
    if (current !== undefined) {
      await releaseLeases(current.superuserUrl);
    }
    current = undefined;
  });

  it('lets the api finish an in-flight request on SIGTERM without duplicating it', async () => {
    const scenario = await prepareScenario();
    current = scenario.database;
    const databaseUrl = scenario.database.superuserUrl;
    try {
      const api = await spawnRole(scenario, 'api');
      const wallet = await prepareWallet(scenario, api);
      const token = await providerToken(scenario);
      const bet = betCommand({ wallet });
      const holder = await lockWallet(databaseUrl, wallet.id);
      const inFlight = submitViaApi(api.baseUrl, token, bet).then(
        async (response) => {
          await response.arrayBuffer();
          return response.status;
        },
        () => undefined,
      );
      await waitForLockWaiter(databaseUrl);
      const shutdown = sigterm(api);
      await Bun.sleep(WORK_RELEASE_DELAY_MS);
      await holder.release();
      expectGracefulExit(await shutdown);
      const answered = await inFlight;
      expect(answered === undefined || answered === 200 || answered === 503).toBe(true);
      await api.restart();
      const retried = await submitViaApi(api.baseUrl, token, bet);
      expect(retried.status).toBe(200);
      expect(await retried.json()).toMatchObject({ status: 'PROCESSED' });
      const rows = await transactionsOf(databaseUrl, bet.body.externalTransactionId);
      expect(rows.map((row) => row.status)).toEqual(['PROCESSED']);
      expect(await entriesOf(databaseUrl, bet.body.externalTransactionId)).toBe(2);
      expect(await balanceOf(databaseUrl, wallet.id)).toBe('990.00');
    } finally {
      await finish(scenario);
    }
  });

  it('returns the message held by the consumer on SIGTERM and processes it once after restart', async () => {
    const scenario = await prepareScenario();
    current = scenario.database;
    const databaseUrl = scenario.database.superuserUrl;
    const sqs = createTestSqsClient();
    try {
      const api = await spawnRole(scenario, 'api');
      const consumer = await spawnRole(scenario, 'consumer');
      const wallet = await prepareWallet(scenario, api);
      const bet = betCommand({ wallet });
      const holder = await lockWallet(databaseUrl, wallet.id);
      await publishEnvelope(
        sqs,
        scenario.queues.urls.wagerTransactions,
        buildEnvelope({ data: toMessageData(bet) }),
      );
      await waitForLockWaiter(databaseUrl);
      const shutdown = await sigterm(consumer);
      await holder.release();
      expectGracefulExit(shutdown);
      expect(await transactionsOf(databaseUrl, bet.body.externalTransactionId)).toEqual([]);
      expect((await countMessages(sqs, scenario.queues.urls.wagerTransactions)).total).toBe(1);
      await consumer.restart();
      await waitFor(
        async () => (await countMessages(sqs, scenario.queues.urls.wagerTransactions)).total === 0,
        WAIT,
      );
      const rows = await transactionsOf(databaseUrl, bet.body.externalTransactionId);
      expect(rows.map((row) => row.status)).toEqual(['PROCESSED']);
      expect(await entriesOf(databaseUrl, bet.body.externalTransactionId)).toBe(2);
      expect(await balanceOf(databaseUrl, wallet.id)).toBe('990.00');
      expect(
        await countOf(
          databaseUrl,
          'select count(*)::int as total from inbox_messages where consumer_name = $1',
          [WAGER_CONSUMER],
        ),
      ).toBe(1);
    } finally {
      sqs.destroy();
      await finish(scenario);
    }
  });

  it('stops the outbox mid-publish on SIGTERM and publishes every event once after restart', async () => {
    const scenario = await prepareScenario();
    current = scenario.database;
    const databaseUrl = scenario.database.superuserUrl;
    let paused = false;
    try {
      const api = await spawnRole(scenario, 'api');
      const outbox = await spawnRole(scenario, 'outbox');
      const wallet = await prepareWallet(scenario, api);
      await waitUntilOutboxDrained(databaseUrl);
      await pause('ministack');
      paused = true;
      const token = await providerToken(scenario);
      const bet = betCommand({ wallet });
      const submitted = await submitViaApi(api.baseUrl, token, bet);
      await submitted.arrayBuffer();
      expect(submitted.status).toBe(200);
      await waitFor(async () => (await claimedOutbox(databaseUrl)) > 0, WAIT);
      const shutdown = await sigterm(outbox);
      await unpause('ministack');
      paused = false;
      expectGracefulExit(shutdown);
      expect(await unpublishedOutbox(databaseUrl)).toBeGreaterThan(0);
      await outbox.restart();
      await spawnRole(scenario, 'events-audit');
      await waitUntilOutboxDrained(databaseUrl);
      const events = await outboxIds(databaseUrl);
      await waitFor(async () => (await auditedEvents(databaseUrl)) === events.length, WAIT);
      expect(
        await countOf(
          databaseUrl,
          `select count(*)::int as total from inbox_messages
            where consumer_name = $1 and message_id = any($2::text[])`,
          [AUDIT_CONSUMER, events],
        ),
      ).toBe(events.length);
      expect(await transactionsOf(databaseUrl, bet.body.externalTransactionId)).toHaveLength(1);
    } finally {
      if (paused) {
        await unpause('ministack');
      }
      await finish(scenario);
    }
  });

  it('stops the scheduler mid-resolution on SIGTERM and resolves the pending reference once after restart', async () => {
    const scenario = await prepareScenario();
    current = scenario.database;
    const databaseUrl = scenario.database.superuserUrl;
    try {
      const api = await spawnRole(scenario, 'api');
      const wallet = await prepareWallet(scenario, api);
      const token = await providerToken(scenario);
      const roundId = `round-${crypto.randomUUID()}`;
      const bet = betCommand({ wallet, roundId });
      const refund = refundCommand({
        wallet,
        roundId,
        referenceExternalTransactionId: bet.body.externalTransactionId,
      });
      const accepted = await submitViaApi(api.baseUrl, token, refund);
      await accepted.arrayBuffer();
      expect(accepted.status).toBe(202);
      const processed = await submitViaApi(api.baseUrl, token, bet);
      await processed.arrayBuffer();
      expect(processed.status).toBe(200);
      const holder = await lockWallet(databaseUrl, wallet.id);
      const scheduler = await spawnRole(scenario, 'scheduler');
      await waitForLockWaiter(databaseUrl);
      const shutdown = await sigterm(scheduler);
      await holder.release();
      expectGracefulExit(shutdown);
      const parked = await transactionsOf(databaseUrl, refund.body.externalTransactionId);
      expect(parked.map((row) => row.status)).toEqual(['PENDING_REFERENCE']);
      await scheduler.restart();
      await waitFor(async () => {
        const rows = await transactionsOf(databaseUrl, refund.body.externalTransactionId);
        return rows[0]?.status === 'PROCESSED';
      }, WAIT);
      const rows = await transactionsOf(databaseUrl, refund.body.externalTransactionId);
      expect(rows).toHaveLength(1);
      expect(await entriesOf(databaseUrl, refund.body.externalTransactionId)).toBe(2);
      expect(await balanceOf(databaseUrl, wallet.id)).toBe('1000.00');
    } finally {
      await finish(scenario);
    }
  });

  it('leaves the event held by events-audit for redelivery on SIGTERM and records it once after restart', async () => {
    const scenario = await prepareScenario();
    current = scenario.database;
    const databaseUrl = scenario.database.superuserUrl;
    try {
      const api = await spawnRole(scenario, 'api');
      await spawnRole(scenario, 'outbox');
      const wallet = await prepareWallet(scenario, api);
      const token = await providerToken(scenario);
      const bet = betCommand({ wallet });
      const submitted = await submitViaApi(api.baseUrl, token, bet);
      await submitted.arrayBuffer();
      expect(submitted.status).toBe(200);
      await waitUntilOutboxDrained(databaseUrl);
      const events = await outboxIds(databaseUrl);
      const holder = await LockHolder.begin(databaseUrl);
      await holder.run(
        `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
         select $1, id, repeat('f', 64), now() from unnest($2::text[]) as id`,
        [AUDIT_CONSUMER, events],
      );
      const audit = await spawnRole(scenario, 'events-audit');
      await waitForLockWaiter(databaseUrl);
      const shutdown = await sigterm(audit);
      await holder.release();
      expectGracefulExit(shutdown);
      expect(await auditedEvents(databaseUrl)).toBe(0);
      await audit.restart();
      await waitFor(async () => (await auditedEvents(databaseUrl)) === events.length, WAIT);
      expect(
        await countOf(
          databaseUrl,
          'select count(*)::int as total from inbox_messages where consumer_name = $1',
          [AUDIT_CONSUMER],
        ),
      ).toBe(events.length);
    } finally {
      await finish(scenario);
    }
  });
});
