import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { FAULT_KILL_EXIT_CODE, NO_FAULT_ENV, faultEnv } from '@test/support/fault-env';
import { betCommand, createWalletViaApi, toMessageData } from '@test/support/fixtures';
import {
  SIGTERM_EXIT_CODE,
  SpawnInstancesError,
  spawnInstances,
} from '@test/support/spawn-instances';
import type { InstanceRole, LogEntry, SpawnedInstances } from '@test/support/spawn-instances';
import {
  buildEnvelope,
  countMessages,
  createTestSqsClient,
  publishEnvelope,
} from '@test/support/sqs';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TestIssuer } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';
import type { TestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

const WORKER_ROLES: readonly InstanceRole[] = ['consumer', 'outbox', 'scheduler', 'events-audit'];
const DRAIN_WAIT = { timeoutMs: 30_000, intervalMs: 200 } as const;
const CRASH_TIMEOUT_MS = 30_000;

interface ProcessEnvironment {
  readonly database: TestDatabase;
  readonly queues: TestQueues;
  readonly issuer: TestIssuer;
  readonly env: Readonly<Record<string, string>>;
}

const prepareEnvironment = async (): Promise<ProcessEnvironment> => {
  const database = await createTestDatabase();
  const queues = await createTestQueues();
  const issuer = await TestIssuer.start();
  return {
    database,
    queues,
    issuer,
    env: { DATABASE_URL: database.appUrl, ...queues.env, ...issuer.authConfig },
  };
};

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

const readyStatus = async (baseUrl: string): Promise<number> => {
  const response = await fetch(`${baseUrl}/health/ready`);
  await response.arrayBuffer();
  return response.status;
};

const startedBy =
  (role: InstanceRole) =>
  (entry: LogEntry): boolean =>
    entry.message === `${role} started`;

const stopAll = async (groups: readonly SpawnedInstances[]): Promise<void> => {
  await Promise.all(groups.map((group) => group.stop()));
};

describe('process helpers', () => {
  it('spawns three api processes with their own instance id and port', async () => {
    const { issuer, env } = await prepareEnvironment();
    const apis = await spawnInstances({ role: 'api', count: 3, env });
    try {
      const instances = apis.instances;
      expect(instances).toHaveLength(3);
      expect(new Set(instances.map((instance) => instance.instanceId)).size).toBe(3);
      expect(new Set(instances.map((instance) => instance.port)).size).toBe(3);
      expect(new Set(instances.map((instance) => instance.pid)).size).toBe(3);
      for (const instance of instances) {
        const started = await instance.waitForLog(startedBy('api'));
        expect(started).toMatchObject({ instanceId: instance.instanceId, port: instance.port });
        expect(instance.running).toBe(true);
        expect(instance.exitCode).toBeUndefined();
        expect(await readyStatus(instance.baseUrl)).toBe(200);
        expect(instance.logs()).toHaveLength(instance.stdoutLines().length);
      }
      const operatorToken = await issuer.token({ role: 'operator' });
      const wallet = await createWalletViaApi(apis.instance(1).baseUrl, operatorToken);
      const fetched = await fetch(`${apis.instance(2).baseUrl}/wallets/${wallet.id}`, {
        headers: { Authorization: `Bearer ${operatorToken}` },
      });
      await fetched.arrayBuffer();
      expect(fetched.status).toBe(200);
      const outOfRange = (() => {
        try {
          return apis.instance(3);
        } catch (error) {
          return error;
        }
      })();
      expect(outOfRange).toBeInstanceOf(SpawnInstancesError);
    } finally {
      await apis.stop();
      await issuer.stop();
    }
  });

  it('stops a process with SIGTERM and restarts it on the same port', async () => {
    const { issuer, env } = await prepareEnvironment();
    const apis = await spawnInstances({ role: 'api', count: 1, env });
    try {
      const api = apis.instance(0);
      const firstPid = api.pid;
      expect(await api.kill('SIGTERM')).toBe(SIGTERM_EXIT_CODE);
      expect(api.running).toBe(false);
      expect(api.exitCode).toBe(SIGTERM_EXIT_CODE);
      const linesBeforeRestart = api.stdoutLines().length;
      await api.restart();
      expect(api.running).toBe(true);
      expect(api.pid).not.toBe(firstPid);
      const started = await api.waitForLog(startedBy('api'), { fromLine: linesBeforeRestart });
      expect(started).toMatchObject({ instanceId: api.instanceId, port: api.port });
      expect(await readyStatus(api.baseUrl)).toBe(200);
    } finally {
      await apis.stop();
      await issuer.stop();
    }
  });

  it('spawns every worker role and waits for its readiness', async () => {
    const { issuer, env } = await prepareEnvironment();
    const settled = await Promise.allSettled(
      WORKER_ROLES.map((role) => spawnInstances({ role, count: 1, env })),
    );
    const groups = settled.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    try {
      expect(settled.map((result) => result.status)).toEqual(WORKER_ROLES.map(() => 'fulfilled'));
      for (const group of groups) {
        const instance = group.instance(0);
        const started = await instance.waitForLog(startedBy(group.role));
        expect(started).toMatchObject({ instanceId: instance.instanceId });
        expect(await readyStatus(instance.baseUrl)).toBe(200);
      }
    } finally {
      await stopAll(groups);
      await issuer.stop();
    }
  });

  it('rejects a spawn without the shared queue and database environment', async () => {
    const failure = await spawnInstances({ role: 'consumer', count: 1, env: {} }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(failure).toBeInstanceOf(SpawnInstancesError);
    expect(Reflect.get(failure ?? {}, 'message')).toContain('DATABASE_URL');
  });

  it('kills a consumer with SIGKILL at its fault point and restarts it without faults', async () => {
    const { database, queues, issuer, env } = await prepareEnvironment();
    const sqs = createTestSqsClient();
    const apis = await spawnInstances({ role: 'api', count: 1, env });
    const consumers = await spawnInstances({
      role: 'consumer',
      count: 1,
      env: { ...env, ...faultEnv('consumer.after_commit_before_ack') },
    });
    try {
      const consumer = consumers.instance(0);
      await consumer.waitForLog(startedBy('consumer'));
      const operatorToken = await issuer.token({ role: 'operator' });
      const wallet = await createWalletViaApi(apis.instance(0).baseUrl, operatorToken);
      const request = betCommand({ wallet });
      await publishEnvelope(
        sqs,
        queues.urls.wagerTransactions,
        buildEnvelope({ data: toMessageData(request) }),
      );
      expect(await consumer.waitForExit(CRASH_TIMEOUT_MS)).toBe(FAULT_KILL_EXIT_CODE);
      expect(consumer.running).toBe(false);
      const committed = await queryRows(
        database.appUrl,
        'SELECT status FROM wager_transactions WHERE external_transaction_id = $1',
        [request.body.externalTransactionId],
      );
      expect(committed).toEqual([{ status: 'PROCESSED' }]);
      await consumer.restart({ env: NO_FAULT_ENV });
      await waitFor(
        async () => (await countMessages(sqs, queues.urls.wagerTransactions)).total === 0,
        DRAIN_WAIT,
      );
      expect(consumer.running).toBe(true);
      const entries = await queryRows(
        database.appUrl,
        `SELECT le.account_kind, le.direction
           FROM ledger_entries le
           JOIN wager_transactions wt ON wt.id = le.transaction_id
          WHERE wt.external_transaction_id = $1
          ORDER BY le.account_kind`,
        [request.body.externalTransactionId],
      );
      expect(entries).toEqual([
        { account_kind: 'HOUSE', direction: 'CREDIT' },
        { account_kind: 'WALLET', direction: 'DEBIT' },
      ]);
    } finally {
      sqs.destroy();
      await stopAll([consumers, apis]);
      await issuer.stop();
    }
  });
});
