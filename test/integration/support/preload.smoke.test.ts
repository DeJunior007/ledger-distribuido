import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { containerState, pause, unpause } from '@test/support/containers';
import { currentDatabaseUrl } from '@test/support/current-database';
import {
  APP_ROLE,
  OWNER_ROLE,
  TEMPLATE_DATABASE,
  createTestDatabase,
  superuserUrl,
} from '@test/support/test-database';
import { WaitForTimeoutError, waitFor } from '@test/support/wait-for';

const QUICK_WAIT = { timeoutMs: 2_000, intervalMs: 20 } as const;

const queryRows = async (
  connectionString: string,
  sql: string,
  values: readonly unknown[] = [],
): Promise<Record<string, unknown>[]> => {
  const client = new Client({ connectionString, connectionTimeoutMillis: 1_000 });
  await client.connect();
  try {
    const result = await client.query<Record<string, unknown>>(sql, [...values]);
    return result.rows;
  } finally {
    await client.end();
  }
};

const canConnect = async (connectionString: string): Promise<boolean> => {
  try {
    await queryRows(connectionString, 'SELECT 1');
    return true;
  } catch {
    return false;
  }
};

describe('integration preload', () => {
  it('publishes the connection variables with random ports', () => {
    expect(process.env.TEST_PG_HOST).toBeTruthy();
    expect(process.env.TEST_PG_PORT).toMatch(/^\d+$/);
    expect(process.env.TEST_PG_PORT).not.toBe('5432');
    expect(process.env.TEST_PG_SUPERUSER_URL).toContain(`:${String(process.env.TEST_PG_PORT)}/`);
    expect(process.env.TEST_SQS_ENDPOINT).toMatch(/^http:\/\/[^:]+:\d+$/);
    expect(process.env.TEST_SQS_ENDPOINT).not.toEndWith(':4566');
  });

  it('creates both roles and a template database owned by jungle_owner', async () => {
    const roles = await queryRows(
      superuserUrl('postgres'),
      'SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname',
      [[APP_ROLE, OWNER_ROLE]],
    );
    expect(roles).toEqual([
      { rolname: APP_ROLE, rolcanlogin: true },
      { rolname: OWNER_ROLE, rolcanlogin: true },
    ]);
    const template = await queryRows(
      superuserUrl('postgres'),
      `SELECT pg_get_userbyid(d.datdba) AS owner,
              (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datname = d.datname) AS connections
         FROM pg_database d WHERE d.datname = $1`,
      [TEMPLATE_DATABASE],
    );
    expect(template).toEqual([{ owner: OWNER_ROLE, connections: 0 }]);
  });

  it('creates a per-file database from the migrated template and registers it', async () => {
    const database = await createTestDatabase();
    expect(database.name).toMatch(/^t_[0-9a-f]{32}$/);
    expect(currentDatabaseUrl()).toBe(database.superuserUrl);
    const owner = await queryRows(
      database.superuserUrl,
      'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()',
    );
    expect(owner).toEqual([{ owner: OWNER_ROLE }]);
    const migrationsTable = await queryRows(
      database.ownerUrl,
      `SELECT to_regclass('public.mikro_orm_migrations') IS NOT NULL AS present`,
    );
    expect(migrationsTable).toEqual([{ present: true }]);
    const appUser = await queryRows(database.appUrl, 'SELECT current_user AS name');
    expect(appUser).toEqual([{ name: APP_ROLE }]);
  });

  it('releases the registered database in the global afterEach', () => {
    expect(currentDatabaseUrl()).toBeUndefined();
  });

  it('reaches the emulator health endpoint', async () => {
    const response = await fetch(`${String(process.env.TEST_SQS_ENDPOINT)}/_ministack/health`);
    expect(response.status).toBe(200);
  });

  it('pauses and unpauses PostgreSQL by container id', async () => {
    const url = superuserUrl('postgres');
    await pause('postgres');
    try {
      expect(await containerState('postgres')).toBe('paused');
      expect(await canConnect(url)).toBe(false);
    } finally {
      await unpause('postgres');
    }
    expect(await containerState('postgres')).toBe('running');
    await waitFor(() => canConnect(url), { timeoutMs: 10_000, intervalMs: 100 });
  });

  it('pauses and unpauses MiniStack by container id', async () => {
    await pause('ministack');
    try {
      expect(await containerState('ministack')).toBe('paused');
    } finally {
      await unpause('ministack');
    }
    expect(await containerState('ministack')).toBe('running');
    const response = await fetch(`${String(process.env.TEST_SQS_ENDPOINT)}/_ministack/health`);
    expect(response.status).toBe(200);
  });

  it('waits for a condition and fails with an explicit timeout', async () => {
    let attempts = 0;
    await waitFor(() => {
      attempts += 1;
      return attempts >= 3;
    }, QUICK_WAIT);
    expect(attempts).toBe(3);
    const failure = await waitFor(() => false, { timeoutMs: 100, intervalMs: 20 }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(WaitForTimeoutError);
  });
});
