import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MikroORM } from '@mikro-orm/postgresql';
import { Client } from 'pg';
import { loadConfig } from '@infrastructure/config/env.schema';
import { buildOrmOptions } from '@infrastructure/persistence/mikro-orm.config';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';

const FIXTURE_NAME = 'Migration9999MigratorFixture';
const FIXTURE_TABLE = 'migrator_fixture';

const fixtureSource = (
  migrationModule: string,
): string => `import { Migration } from '${migrationModule}';

export class ${FIXTURE_NAME} extends Migration {
  override up(): void {
    this.addSql('CREATE TABLE ${FIXTURE_TABLE} (id integer PRIMARY KEY)');
  }

  override down(): void {
    this.addSql('DROP TABLE ${FIXTURE_TABLE}');
  }
}
`;

const scalar = async (
  connectionString: string,
  sql: string,
  values: readonly unknown[],
): Promise<unknown> => {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query<{ value: unknown }>(sql, [...values]);
    return result.rows[0]?.value;
  } finally {
    await client.end();
  }
};

const fixtureTablePresent = (database: TestDatabase): Promise<unknown> =>
  scalar(database.ownerUrl, 'SELECT to_regclass($1) IS NOT NULL AS value', [
    `public.${FIXTURE_TABLE}`,
  ]);

const fixtureRecorded = (database: TestDatabase): Promise<unknown> =>
  scalar(
    database.ownerUrl,
    'SELECT count(*)::int AS value FROM mikro_orm_migrations WHERE name = $1',
    [FIXTURE_NAME],
  );

describe('migrator', () => {
  let fixtureDir = '';

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), 'jungle-migrator-'));
    const migrationModule = Bun.resolveSync('@mikro-orm/migrations', import.meta.dir);
    await writeFile(join(fixtureDir, `${FIXTURE_NAME}.ts`), fixtureSource(migrationModule));
  });

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it('applies and reverts a temporary fixture migration', async () => {
    const database = await createTestDatabase();
    const config = loadConfig({ MIGRATION_DATABASE_URL: database.ownerUrl }, { role: 'migrate' });
    const options = buildOrmOptions('migrator', config);
    const orm = await MikroORM.init({
      ...options,
      migrations: { ...options.migrations, path: fixtureDir, silent: true },
    });
    try {
      const applied = await orm.migrator.up();
      expect(applied.map((migration) => migration.name)).toEqual([FIXTURE_NAME]);
      expect(await fixtureTablePresent(database)).toBe(true);
      expect(await fixtureRecorded(database)).toBe(1);

      const reverted = await orm.migrator.down();
      expect(reverted.map((migration) => migration.name)).toEqual([FIXTURE_NAME]);
      expect(await fixtureTablePresent(database)).toBe(false);
      expect(await fixtureRecorded(database)).toBe(0);
    } finally {
      await orm.close(true);
    }
  });
});
