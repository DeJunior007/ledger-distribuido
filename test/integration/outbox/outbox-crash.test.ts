import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Client } from 'pg';
import type { FaultPoint } from '@application/ports/fault-injector.port';
import { FAULT_KILL_EXIT_CODE, NO_FAULT_ENV, faultEnv } from '@test/support/fault-env';
import { betCommand, createWalletViaApi, submitViaApi } from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import { spawnInstances } from '@test/support/spawn-instances';
import type { SpawnedInstance, SpawnedInstances } from '@test/support/spawn-instances';
import { countMessages, createTestSqsClient, peekMessages, publishBody } from '@test/support/sqs';
import type { ReceivedTestMessage } from '@test/support/sqs';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID, TestIssuer } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';
import type { TestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

const AUDIT_CONSUMER = 'wallet-events-audit';
const LEASE_MS = 2_000;
const CRASH_TIMEOUT_MS = 30_000;
const DRAIN_WAIT = { timeoutMs: 60_000, intervalMs: 100 } as const;
const TEST_TIMEOUT_MS = 150_000;
const PROVIDER_TOKEN = { role: 'provider', providerId: TEST_PROVIDER_ID } as const;

interface CrashEnvironment {
  readonly database: TestDatabase;
  readonly queues: TestQueues;
  readonly issuer: TestIssuer;
  readonly sqs: SQSClient;
  readonly env: Readonly<Record<string, string>>;
}

interface OutboxRow {
  readonly id: string;
  readonly published_at: Date | null;
  readonly locked_by: string | null;
  readonly locked_until: Date | null;
}

interface CrashedRun {
  readonly wallet: TestWallet;
  readonly claimed: readonly OutboxRow[];
  readonly api: SpawnedInstance;
}

const queryRows = async <Row extends object>(
  database: TestDatabase,
  sql: string,
  params: readonly unknown[] = [],
): Promise<Row[]> => {
  const client = new Client({ connectionString: database.superuserUrl });
  await client.connect();
  try {
    const result = await client.query<Row>(sql, [...params]);
    return result.rows;
  } finally {
    await client.end();
  }
};

const outboxRows = (database: TestDatabase): Promise<OutboxRow[]> =>
  queryRows<OutboxRow>(
    database,
    'SELECT id, published_at, locked_by, locked_until FROM outbox_messages ORDER BY id',
  );

const auditedIds = async (database: TestDatabase): Promise<string[]> =>
  (
    await queryRows<{ message_id: string }>(
      database,
      `SELECT message_id FROM inbox_messages
        WHERE consumer_name = $1 AND processed_at IS NOT NULL ORDER BY message_id`,
      [AUDIT_CONSUMER],
    )
  ).map((row) => row.message_id);

const metricValue = async (instance: SpawnedInstance, series: string): Promise<number> => {
  const response = await fetch(`${instance.baseUrl}/metrics`);
  const line = (await response.text())
    .split('\n')
    .find((candidate) => candidate.startsWith(`${series} `));
  return line === undefined ? 0 : Number(line.slice(line.lastIndexOf(' ') + 1));
};

const publishedBy = (instance: SpawnedInstance): Promise<number> =>
  metricValue(instance, 'jungle_outbox_publish_total{result="published"}');

const sortedDeduplicationIds = (messages: readonly ReceivedTestMessage[]): string[] =>
  messages.map((message) => message.deduplicationId ?? '').sort();

const prepareEnvironment = async (): Promise<CrashEnvironment> => {
  const database = await createTestDatabase();
  const queues = await createTestQueues();
  const issuer = await TestIssuer.start();
  return {
    database,
    queues,
    issuer,
    sqs: createTestSqsClient(),
    env: {
      DATABASE_URL: database.appUrl,
      ...queues.env,
      ...issuer.authConfig,
      OUTBOX_LEASE_MS: String(LEASE_MS),
    },
  };
};

const crashOutboxAt = async (
  environment: CrashEnvironment,
  point: FaultPoint,
  groups: SpawnedInstances[],
): Promise<CrashedRun> => {
  const apis = await spawnInstances({ role: 'api', count: 1, env: environment.env });
  groups.push(apis);
  const victims = await spawnInstances({
    role: 'outbox',
    count: 1,
    env: { ...environment.env, ...faultEnv(point) },
  });
  groups.push(victims);
  const victim = victims.instance(0);
  const operatorToken = await environment.issuer.token({ role: 'operator' });
  const wallet = await createWalletViaApi(apis.instance(0).baseUrl, operatorToken);

  expect(await victim.waitForExit(CRASH_TIMEOUT_MS)).toBe(FAULT_KILL_EXIT_CODE);
  const claimed = await outboxRows(environment.database);
  expect(claimed.length).toBeGreaterThan(0);
  for (const row of claimed) {
    expect(row.published_at).toBeNull();
    expect(row.locked_by).toBe(victim.instanceId);
    expect(row.locked_until).not.toBeNull();
  }
  return { wallet, claimed, api: apis.instance(0) };
};

const takeOver = async (
  environment: CrashEnvironment,
  groups: SpawnedInstances[],
): Promise<SpawnedInstance> => {
  const survivors = await spawnInstances({
    role: 'outbox',
    count: 1,
    env: { ...environment.env, ...NO_FAULT_ENV },
  });
  groups.push(survivors);
  return survivors.instance(0);
};

const waitUntilPublished = (database: TestDatabase, count: number): Promise<void> =>
  waitFor(async () => {
    const rows = await outboxRows(database);
    return rows.length === count && rows.every((row) => row.published_at !== null);
  }, DRAIN_WAIT);

const expectPublishedAfterLease = (
  claimed: readonly OutboxRow[],
  published: readonly OutboxRow[],
): void => {
  const leaseEnds = new Map(claimed.map((row) => [row.id, row.locked_until?.getTime() ?? 0]));
  for (const row of published) {
    const leaseEnd = leaseEnds.get(row.id);
    if (leaseEnd !== undefined) {
      expect(row.published_at?.getTime() ?? 0).toBeGreaterThanOrEqual(leaseEnd);
    }
    expect(row.locked_by).toBeNull();
    expect(row.locked_until).toBeNull();
  }
};

const startAudit = async (
  environment: CrashEnvironment,
  groups: SpawnedInstances[],
): Promise<SpawnedInstance> => {
  const audits = await spawnInstances({
    role: 'events-audit',
    count: 1,
    env: environment.env,
  });
  groups.push(audits);
  return audits.instance(0);
};

const waitUntilAudited = (environment: CrashEnvironment, count: number): Promise<void> =>
  waitFor(
    async () =>
      (await auditedIds(environment.database)).length === count &&
      (await countMessages(environment.sqs, environment.queues.urls.walletEvents)).total === 0,
    DRAIN_WAIT,
  );

const redeliverOutsideDeduplicationWindow = async (
  environment: CrashEnvironment,
  messages: readonly ReceivedTestMessage[],
): Promise<void> => {
  for (const message of messages) {
    await publishBody(environment.sqs, environment.queues.urls.walletEvents, message.body, {
      groupId: message.groupId ?? '',
      deduplicationId: randomUUID(),
      attributes: message.attributes,
    });
  }
};

const release = async (
  environment: CrashEnvironment,
  groups: readonly SpawnedInstances[],
): Promise<void> => {
  await Promise.all(groups.map((group) => group.stop()));
  environment.sqs.destroy();
  await environment.issuer.stop();
};

describe('outbox crash between commit and publish', () => {
  it(
    'lets another instance publish after the lease when the publisher dies before publishing',
    async () => {
      const environment = await prepareEnvironment();
      const { database, queues, sqs } = environment;
      const groups: SpawnedInstances[] = [];
      try {
        const { wallet, claimed, api } = await crashOutboxAt(
          environment,
          'outbox.after_claim_before_publish',
          groups,
        );
        expect((await countMessages(sqs, queues.urls.walletEvents)).total).toBe(0);
        const providerToken = await environment.issuer.token(PROVIDER_TOKEN);
        const placed = await submitViaApi(api.baseUrl, providerToken, betCommand({ wallet }));
        await placed.arrayBuffer();
        expect(placed.status).toBe(200);
        const committed = await outboxRows(database);
        expect(committed.length).toBeGreaterThan(claimed.length);

        const survivor = await takeOver(environment, groups);
        await waitUntilPublished(database, committed.length);

        const published = await outboxRows(database);
        expectPublishedAfterLease(claimed, published);
        expect(await publishedBy(survivor)).toBe(committed.length);
        const delivered = await peekMessages(sqs, queues.urls.walletEvents);
        expect(sortedDeduplicationIds(delivered)).toEqual(published.map((row) => row.id));
        await startAudit(environment, groups);
        await waitUntilAudited(environment, committed.length);
        expect(await auditedIds(database)).toEqual(published.map((row) => row.id));
      } finally {
        await release(environment, groups);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'publishes the event twice and audits it once when the publisher dies before marking it',
    async () => {
      const environment = await prepareEnvironment();
      const { database, queues, sqs } = environment;
      const groups: SpawnedInstances[] = [];
      try {
        const { claimed } = await crashOutboxAt(
          environment,
          'outbox.after_publish_before_mark',
          groups,
        );
        const eventIds = claimed.map((row) => row.id);
        const firstCopies = await peekMessages(sqs, queues.urls.walletEvents);
        expect(sortedDeduplicationIds(firstCopies)).toEqual(eventIds);

        const survivor = await takeOver(environment, groups);
        await waitUntilPublished(database, claimed.length);

        expectPublishedAfterLease(claimed, await outboxRows(database));
        expect(await publishedBy(survivor)).toBe(claimed.length);
        expect((await countMessages(sqs, queues.urls.walletEvents)).total).toBe(claimed.length);
        await redeliverOutsideDeduplicationWindow(environment, firstCopies);
        expect((await countMessages(sqs, queues.urls.walletEvents)).total).toBe(claimed.length * 2);

        const audit = await startAudit(environment, groups);
        await waitUntilAudited(environment, claimed.length);

        expect(await auditedIds(database)).toEqual(eventIds);
        expect(
          await metricValue(audit, `jungle_inbox_duplicates_total{consumer="${AUDIT_CONSUMER}"}`),
        ).toBe(claimed.length);
        expect(
          await metricValue(
            audit,
            `jungle_inbox_payload_mismatch_total{consumer="${AUDIT_CONSUMER}"}`,
          ),
        ).toBe(0);
      } finally {
        await release(environment, groups);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
