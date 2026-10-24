import { describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { Client } from 'pg';
import { loadConfig } from '@infrastructure/config/env.schema';
import { buildOrmOptions } from '@infrastructure/persistence/mikro-orm.config';
import { registerCurrentDatabase } from '@test/support/current-database';
import {
  APP_ROLE,
  OWNER_ROLE,
  OWNER_TEST_PASSWORD,
  roleUrl,
  superuserUrl,
} from '@test/support/test-database';

const MIGRATION_NAMES = [
  'Migration0001WalletsAndHouseAccounts',
  'Migration0002WagerTransactions',
  'Migration0003LedgerEntries',
  'Migration0004IdempotencyAndInbox',
  'Migration0005OutboxAndWorkers',
  'Migration0006Guards',
  'Migration0007Grants',
];

const MIGRATIONS_TABLE = 'mikro_orm_migrations';

const SCHEMA_RELATIONS = [
  'house_accounts',
  'idempotency_records',
  'inbox_messages',
  'ledger_entries',
  'outbox_messages',
  'pending_reference_retries',
  'reconciliation_runs',
  'scheduled_jobs',
  'wager_transactions',
  'wallet_ledger_entries',
  'wallets',
];

interface EmptyDatabase {
  readonly ownerUrl: string;
  readonly superuserUrl: string;
}

const withClient = async <T>(url: string, work: (client: Client) => Promise<T>): Promise<T> => {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
};

const createEmptyDatabase = async (): Promise<EmptyDatabase> => {
  const name = `t_${crypto.randomUUID().replaceAll('-', '')}`;
  await withClient(superuserUrl('postgres'), async (admin) => {
    await admin.query(`CREATE DATABASE ${name} TEMPLATE template0 OWNER ${OWNER_ROLE}`);
  });
  await withClient(superuserUrl(name), async (admin) => {
    await admin.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${OWNER_ROLE}`);
  });
  return {
    ownerUrl: roleUrl(OWNER_ROLE, OWNER_TEST_PASSWORD, name),
    superuserUrl: superuserUrl(name),
  };
};

const publicRelations = (url: string): Promise<string[]> =>
  withClient(url, async (client) => {
    const result = await client.query<{ name: string }>(
      `SELECT c.relname AS name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v') AND c.relname <> $1
       ORDER BY c.relname`,
      [MIGRATIONS_TABLE],
    );
    return result.rows.map((row) => row.name);
  });

const tablePrivilege = (client: Client, relation: string, privilege: string): Promise<boolean> =>
  client
    .query<{ allowed: boolean }>('SELECT has_table_privilege($1, $2, $3) AS allowed', [
      APP_ROLE,
      `public.${relation}`,
      privilege,
    ])
    .then((result) => result.rows[0]?.allowed === true);

const columnPrivilege = (
  client: Client,
  relation: string,
  column: string,
  privilege: string,
): Promise<boolean> =>
  client
    .query<{ allowed: boolean }>('SELECT has_column_privilege($1, $2, $3, $4) AS allowed', [
      APP_ROLE,
      `public.${relation}`,
      column,
      privilege,
    ])
    .then((result) => result.rows[0]?.allowed === true);

const anyColumnPrivilege = (
  client: Client,
  relation: string,
  privilege: string,
): Promise<boolean> =>
  client
    .query<{ allowed: boolean }>('SELECT has_any_column_privilege($1, $2, $3) AS allowed', [
      APP_ROLE,
      `public.${relation}`,
      privilege,
    ])
    .then((result) => result.rows[0]?.allowed === true);

const removalPrivileges = async (
  client: Client,
  relations: readonly string[],
): Promise<string[]> => {
  const granted: string[] = [];
  for (const relation of relations) {
    for (const privilege of ['DELETE', 'TRUNCATE']) {
      if (await tablePrivilege(client, relation, privilege)) {
        granted.push(`${privilege} ${relation}`);
      }
    }
  }
  return granted;
};

describe('migrations', () => {
  it('go up, down and up again on an empty database and leave jungle_app with the granted privileges only', async () => {
    const database = await createEmptyDatabase();
    registerCurrentDatabase(database.superuserUrl);
    const config = loadConfig({ MIGRATION_DATABASE_URL: database.ownerUrl }, { role: 'migrate' });
    const options = buildOrmOptions('migrator', config);
    const orm = await MikroORM.init({
      ...options,
      migrations: { ...options.migrations, silent: true },
    });
    try {
      expect(await publicRelations(database.ownerUrl)).toEqual([]);

      const firstUp = await orm.migrator.up();
      expect(firstUp.map((migration) => migration.name)).toEqual(MIGRATION_NAMES);
      expect(await publicRelations(database.ownerUrl)).toEqual(SCHEMA_RELATIONS);

      const down = await orm.migrator.down({ to: 0 });
      expect(down.map((migration) => migration.name)).toEqual([...MIGRATION_NAMES].reverse());
      expect(await publicRelations(database.ownerUrl)).toEqual([]);
      expect(await orm.migrator.getExecutedMigrations()).toEqual([]);

      const secondUp = await orm.migrator.up();
      expect(secondUp.map((migration) => migration.name)).toEqual(MIGRATION_NAMES);
      expect(await publicRelations(database.ownerUrl)).toEqual(SCHEMA_RELATIONS);
    } finally {
      await orm.close(true);
    }

    await withClient(database.superuserUrl, async (client) => {
      expect(await columnPrivilege(client, 'wallets', 'balance', 'UPDATE')).toBe(true);
      expect(await columnPrivilege(client, 'wallets', 'player_id', 'UPDATE')).toBe(false);
      expect(await tablePrivilege(client, 'ledger_entries', 'UPDATE')).toBe(false);
      expect(await anyColumnPrivilege(client, 'ledger_entries', 'UPDATE')).toBe(false);
      expect(await tablePrivilege(client, MIGRATIONS_TABLE, 'SELECT')).toBe(false);
      expect(await removalPrivileges(client, [...SCHEMA_RELATIONS, MIGRATIONS_TABLE])).toEqual([]);
    });
  });
});
