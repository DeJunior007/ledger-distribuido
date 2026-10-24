import { Client } from 'pg';
import { registerCurrentDatabase } from './current-database';

export const TEMPLATE_DATABASE = 'jungle_template';
export const OWNER_ROLE = 'jungle_owner';
export const APP_ROLE = 'jungle_app';
export const OWNER_TEST_PASSWORD = 'jungle_owner_test';
export const APP_TEST_PASSWORD = 'jungle_app_test';

export class MissingTestEnvironmentError extends Error {
  constructor(name: string) {
    super(`${name} is not set; run the suite with --preload ./test/support/preload.ts`);
    this.name = 'MissingTestEnvironmentError';
  }
}

export interface TestDatabase {
  readonly name: string;
  readonly appUrl: string;
  readonly ownerUrl: string;
  readonly superuserUrl: string;
}

const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new MissingTestEnvironmentError(name);
  }
  return value;
};

export const roleUrl = (role: string, password: string, database: string): string => {
  const url = new URL(`postgres://${requiredEnv('TEST_PG_HOST')}`);
  url.port = requiredEnv('TEST_PG_PORT');
  url.username = role;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
};

export const superuserUrl = (database: string): string => {
  const url = new URL(requiredEnv('TEST_PG_SUPERUSER_URL'));
  url.pathname = `/${database}`;
  return url.toString();
};

const newDatabaseName = (): string => `t_${crypto.randomUUID().replaceAll('-', '')}`;

export const createTestDatabase = async (): Promise<TestDatabase> => {
  const name = newDatabaseName();
  const admin = new Client({ connectionString: requiredEnv('TEST_PG_SUPERUSER_URL') });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DATABASE} OWNER ${OWNER_ROLE}`);
  } finally {
    await admin.end();
  }
  const database: TestDatabase = {
    name,
    appUrl: roleUrl(APP_ROLE, APP_TEST_PASSWORD, name),
    ownerUrl: roleUrl(OWNER_ROLE, OWNER_TEST_PASSWORD, name),
    superuserUrl: superuserUrl(name),
  };
  registerCurrentDatabase(database.superuserUrl);
  return database;
};
