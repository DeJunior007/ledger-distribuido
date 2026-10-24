import { Client } from 'pg';
import type { TestDatabase } from './test-database';
import { APP_ROLE } from './test-database';

type SuperuserAccess = Pick<TestDatabase, 'superuserUrl'>;

const runAsSuperuser = async (db: SuperuserAccess, statement: string): Promise<void> => {
  const client = new Client({ connectionString: db.superuserUrl });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
};

export const breakLedgerWrites = (db: SuperuserAccess): Promise<void> =>
  runAsSuperuser(db, `REVOKE INSERT ON ledger_entries FROM ${APP_ROLE}`);

export const breakOutboxWrites = (db: SuperuserAccess): Promise<void> =>
  runAsSuperuser(db, `REVOKE INSERT ON outbox_messages FROM ${APP_ROLE}`);

export const restoreGrants = (db: SuperuserAccess): Promise<void> =>
  runAsSuperuser(db, `GRANT INSERT ON ledger_entries, outbox_messages TO ${APP_ROLE}`);
