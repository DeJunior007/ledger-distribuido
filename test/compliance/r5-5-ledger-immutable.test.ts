import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { createWalletViaUseCase } from '@test/support/fixtures';
import { createTestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';

const PERMISSION_DENIED = '42501';
const APPEND_ONLY = 'JG001';

const TAMPERING = [
  "UPDATE ledger_entries SET amount = amount + 1, created_at = now() WHERE account_kind = 'WALLET'",
  'DELETE FROM ledger_entries',
  'TRUNCATE ledger_entries',
] as const;

const queryRows = async (
  databaseUrl: string,
  sql: string,
  params: readonly unknown[] = [],
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

const ledgerSnapshot = (databaseUrl: string): Promise<Record<string, unknown>[]> =>
  queryRows(
    databaseUrl,
    `SELECT id, transaction_id, direction, amount::text AS amount, created_at
       FROM ledger_entries ORDER BY id`,
  );

const sqlStateOf = async (databaseUrl: string, sql: string): Promise<unknown> => {
  const failure = await queryRows(databaseUrl, sql).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  return typeof failure === 'object' && failure !== null ? Reflect.get(failure, 'code') : failure;
};

const sqlStatesOf = async (databaseUrl: string): Promise<unknown[]> => {
  const states: unknown[] = [];
  for (const sql of TAMPERING) {
    states.push(await sqlStateOf(databaseUrl, sql));
  }
  return states;
};

describe('§5.5 ledger imutável', () => {
  it('denies UPDATE, DELETE and TRUNCATE on ledger_entries to jungle_app and raises JG001 for jungle_owner', async () => {
    const database = await createTestDatabase();
    const app = await createTestApp({ roles: ['api'], env: { DATABASE_URL: database.appUrl } });
    try {
      await createWalletViaUseCase(app);
    } finally {
      await app.stop();
    }
    const before = await ledgerSnapshot(database.superuserUrl);

    const asApp = await sqlStatesOf(database.appUrl);
    const asOwner = await sqlStatesOf(database.ownerUrl);

    expect(before).toHaveLength(2);
    expect(asApp).toEqual(TAMPERING.map(() => PERMISSION_DENIED));
    expect(asOwner).toEqual(TAMPERING.map(() => APPEND_ONLY));
    expect(await ledgerSnapshot(database.superuserUrl)).toEqual(before);
  });
});
