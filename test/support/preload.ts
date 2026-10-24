import { afterAll, afterEach } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { Client } from 'pg';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { loadConfig } from '@infrastructure/config/env.schema';
import { buildOrmOptions } from '@infrastructure/persistence/mikro-orm.config';
import { registerContainer, stopContainers } from './containers';
import { ledgerConsistencyAfterEach } from './ledger-consistency';
import {
  APP_ROLE,
  APP_TEST_PASSWORD,
  OWNER_ROLE,
  OWNER_TEST_PASSWORD,
  TEMPLATE_DATABASE,
} from './test-database';

const POSTGRES_IMAGE = 'postgres:17-alpine';
const MINISTACK_IMAGE =
  'ministackorg/ministack:1.5.31@sha256:e47e700674792f8a4272cb6e65ac84d1a04b4e7e69810339e7b8c7e81f600c29';
const POSTGRES_PORT = 5432;
const MINISTACK_PORT = 4566;
const SUPERUSER = 'postgres';
const SUPERUSER_PASSWORD = 'postgres';

const startPostgres = (): Promise<StartedTestContainer> =>
  new GenericContainer(POSTGRES_IMAGE)
    .withEnvironment({ POSTGRES_USER: SUPERUSER, POSTGRES_PASSWORD: SUPERUSER_PASSWORD })
    .withCommand([
      'postgres',
      '-c',
      'fsync=off',
      '-c',
      'synchronous_commit=off',
      '-c',
      'full_page_writes=off',
    ])
    .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
    .withExposedPorts(POSTGRES_PORT)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

const startMinistack = (): Promise<StartedTestContainer> =>
  new GenericContainer(MINISTACK_IMAGE)
    .withExposedPorts(MINISTACK_PORT)
    .withWaitStrategy(Wait.forHttp('/_ministack/health', MINISTACK_PORT).forStatusCode(200))
    .start();

const serverUrl = (container: StartedTestContainer, port: number, scheme: string): URL =>
  new URL(`${scheme}://${container.getHost()}:${String(container.getMappedPort(port))}`);

const databaseUrl = (base: URL, role: string, password: string, database: string): string => {
  const url = new URL(base);
  url.username = role;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
};

const runAsSuperuser = async (url: string, statements: readonly string[]): Promise<void> => {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    for (const statement of statements) {
      await client.query(statement);
    }
  } finally {
    await client.end();
  }
};

const migrateTemplate = async (migrationUrl: string): Promise<void> => {
  const config = loadConfig({ MIGRATION_DATABASE_URL: migrationUrl }, { role: 'migrate' });
  const orm = await MikroORM.init(buildOrmOptions('migrator', config));
  try {
    await orm.migrator.up();
  } finally {
    await orm.close(true);
  }
};

const prepareTemplate = async (postgresBase: URL): Promise<void> => {
  await runAsSuperuser(databaseUrl(postgresBase, SUPERUSER, SUPERUSER_PASSWORD, 'postgres'), [
    `CREATE ROLE ${OWNER_ROLE} LOGIN PASSWORD '${OWNER_TEST_PASSWORD}'`,
    `CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_TEST_PASSWORD}'`,
    `CREATE DATABASE ${TEMPLATE_DATABASE} OWNER ${OWNER_ROLE}`,
  ]);
  await runAsSuperuser(
    databaseUrl(postgresBase, SUPERUSER, SUPERUSER_PASSWORD, TEMPLATE_DATABASE),
    [
      'REVOKE ALL ON SCHEMA public FROM PUBLIC',
      `GRANT USAGE, CREATE ON SCHEMA public TO ${OWNER_ROLE}`,
    ],
  );
  await migrateTemplate(
    databaseUrl(postgresBase, OWNER_ROLE, OWNER_TEST_PASSWORD, TEMPLATE_DATABASE),
  );
};

const startContainers = async (): Promise<{
  postgres: StartedTestContainer;
  ministack: StartedTestContainer;
}> => {
  const [postgres, ministack] = await Promise.allSettled([startPostgres(), startMinistack()]);
  if (postgres.status === 'fulfilled') {
    registerContainer('postgres', postgres.value);
  }
  if (ministack.status === 'fulfilled') {
    registerContainer('ministack', ministack.value);
  }
  if (postgres.status === 'rejected') {
    await stopContainers();
    throw postgres.reason;
  }
  if (ministack.status === 'rejected') {
    await stopContainers();
    throw ministack.reason;
  }
  return { postgres: postgres.value, ministack: ministack.value };
};

const { postgres, ministack } = await startContainers();
const postgresBase = serverUrl(postgres, POSTGRES_PORT, 'postgres');

try {
  await prepareTemplate(postgresBase);
} catch (error) {
  await stopContainers();
  throw error;
}

process.env.TEST_PG_HOST = postgresBase.hostname;
process.env.TEST_PG_PORT = postgresBase.port;
process.env.TEST_PG_SUPERUSER_URL = databaseUrl(
  postgresBase,
  SUPERUSER,
  SUPERUSER_PASSWORD,
  'postgres',
);
process.env.TEST_SQS_ENDPOINT = serverUrl(ministack, MINISTACK_PORT, 'http').origin;

afterEach(ledgerConsistencyAfterEach());

afterAll(stopContainers);
