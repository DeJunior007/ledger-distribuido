import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { loadConfig } from '@infrastructure/config/env.schema';
import { MikroOrmUnitOfWork } from '@infrastructure/persistence/mikro-orm-unit-of-work';
import { closeOrmInstances, openOrmInstances } from '@infrastructure/persistence/orm-instances';
import type { OrmInstances } from '@infrastructure/persistence/orm-instances';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';

const JOB = 'global-reconciliation';
const LEASE_MS = 30_000;
const COMPLETED_AT = new Date('2026-10-24T12:00:00.000Z');

interface StoredJobRow {
  readonly locked_until: Date | null;
  readonly locked_by: string | null;
  readonly last_run_at: Date | null;
}

describe('MikroOrmScheduledJobRepository', () => {
  let database: TestDatabase;
  let instances: OrmInstances;
  let uow: MikroOrmUnitOfWork;
  let client: Client;

  const acquire = (instanceId: string, minIntervalMs = 0): Promise<boolean> =>
    uow.run('short', (repos) =>
      repos.scheduledJobs.tryAcquire(JOB, instanceId, LEASE_MS, minIntervalMs),
    );

  const complete = (instanceId: string, at = COMPLETED_AT): Promise<void> =>
    uow.run('short', (repos) => repos.scheduledJobs.complete(JOB, instanceId, at));

  const stored = async (): Promise<StoredJobRow | undefined> => {
    const result = await client.query<StoredJobRow>(
      'SELECT locked_until, locked_by, last_run_at FROM scheduled_jobs WHERE name = $1',
      [JOB],
    );
    return result.rows[0];
  };

  const setJob = async (assignments: string): Promise<void> => {
    await client.query(`UPDATE scheduled_jobs SET ${assignments} WHERE name = $1`, [JOB]);
  };

  beforeEach(async () => {
    database = await createTestDatabase();
    const config = loadConfig({ DATABASE_URL: database.appUrl }, { role: 'api' });
    instances = await openOrmInstances(config);
    uow = new MikroOrmUnitOfWork(instances, config);
    client = new Client({ connectionString: database.appUrl });
    await client.connect();
  });

  afterEach(async () => {
    await client.end();
    await closeOrmInstances(instances);
  });

  describe('tryAcquire', () => {
    it('leases a free job to the caller', async () => {
      const before = await client.query<{ now: Date }>('SELECT now() AS now');
      expect(await acquire('instance-a')).toBe(true);
      const row = await stored();
      expect(row?.locked_by).toBe('instance-a');
      expect(row?.locked_until?.getTime()).toBeGreaterThanOrEqual(
        (before.rows[0]?.now.getTime() ?? 0) + LEASE_MS,
      );
    });

    it('refuses a job whose lease is still held and takes it once the lease expires', async () => {
      expect(await acquire('instance-a')).toBe(true);
      expect(await acquire('instance-b')).toBe(false);
      expect((await stored())?.locked_by).toBe('instance-a');
      await setJob(`locked_until = now() - interval '1 second'`);
      expect(await acquire('instance-b')).toBe(true);
      expect((await stored())?.locked_by).toBe('instance-b');
    });

    it('hands the job to exactly one of several concurrent callers', async () => {
      const instancesIds = ['instance-a', 'instance-b', 'instance-c', 'instance-d', 'instance-e'];
      const results = await Promise.all(instancesIds.map((instanceId) => acquire(instanceId)));
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = instancesIds[results.indexOf(true)];
      expect((await stored())?.locked_by).toBe(winner ?? 'none');
    });

    it('waits for the minimum interval since the last run', async () => {
      await setJob(`last_run_at = now() - interval '10 seconds'`);
      expect(await acquire('instance-a', 60_000)).toBe(false);
      expect((await stored())?.locked_by).toBeNull();
      expect(await acquire('instance-a', 5_000)).toBe(true);
    });
  });

  describe('complete', () => {
    it('records the run and frees the lease only for the instance that holds it', async () => {
      expect(await acquire('instance-a')).toBe(true);
      await complete('instance-b');
      expect(await stored()).toMatchObject({ locked_by: 'instance-a', last_run_at: null });
      await complete('instance-a');
      expect(await stored()).toEqual({
        locked_until: null,
        locked_by: null,
        last_run_at: COMPLETED_AT,
      });
    });

    it('blocks a new acquisition until the minimum interval after completion', async () => {
      const now = await client.query<{ now: Date }>('SELECT now() AS now');
      expect(await acquire('instance-a')).toBe(true);
      await complete('instance-a', now.rows[0]?.now ?? COMPLETED_AT);
      expect(await acquire('instance-b', 60_000)).toBe(false);
      expect(await acquire('instance-b', 0)).toBe(true);
    });
  });
});
