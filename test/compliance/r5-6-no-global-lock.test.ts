import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { betCommand, createWalletViaApi, submitViaApi } from '@test/support/fixtures';
import { createTestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID } from '@test/support/test-issuer';
import { waitFor } from '@test/support/wait-for';

const LOCK_WAIT = { timeoutMs: 15_000, intervalMs: 50 } as const;
const APP_ENV = { DB_LOCK_TIMEOUT_MS: '30000' } as const;

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

const waitingOnLock = async (superuserUrl: string, databaseName: string): Promise<number> => {
  const rows = await queryRows(
    superuserUrl,
    `SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = $1 AND wait_event_type = 'Lock'`,
    [databaseName],
  );
  return Number(rows[0]?.waiting ?? 0);
};

const advisoryLocks = async (superuserUrl: string): Promise<number> => {
  const rows = await queryRows(
    superuserUrl,
    "SELECT count(*)::int AS advisory FROM pg_locks WHERE locktype = 'advisory'",
  );
  return Number(rows[0]?.advisory ?? -1);
};

const balanceOf = async (databaseUrl: string, walletId: string): Promise<unknown> => {
  const rows = await queryRows(
    databaseUrl,
    'SELECT balance::text AS balance FROM wallets WHERE id = $1',
    [walletId],
  );
  return rows[0]?.balance;
};

describe('§5.6 nenhum lock global', () => {
  it('completes a bet on wallet B while the test holds the row lock of wallet A', async () => {
    const database = await createTestDatabase();
    const app = await createTestApp({
      roles: ['api'],
      env: { DATABASE_URL: database.appUrl, ...APP_ENV },
    });
    const holder = new Client({ connectionString: database.appUrl });
    await holder.connect();
    let holding = false;
    try {
      const operatorToken = await app.issuer.token({ role: 'operator' });
      const providerToken = await app.issuer.token({
        role: 'provider',
        providerId: TEST_PROVIDER_ID,
      });
      const walletA = await createWalletViaApi(app.baseUrl, operatorToken);
      const walletB = await createWalletViaApi(app.baseUrl, operatorToken);

      await holder.query('BEGIN');
      holding = true;
      await holder.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [walletA.id]);
      const blockedOnA = submitViaApi(
        app.baseUrl,
        providerToken,
        betCommand({ wallet: walletA, amount: '10.00' }),
      );
      await waitFor(
        async () => (await waitingOnLock(database.superuserUrl, database.name)) === 1,
        LOCK_WAIT,
      );

      const onB = await submitViaApi(
        app.baseUrl,
        providerToken,
        betCommand({ wallet: walletB, amount: '10.00' }),
      );

      expect(onB.status).toBe(200);
      expect(await onB.json()).toMatchObject({
        status: 'PROCESSED',
        kind: 'BET',
        balance: { amount: '990.00', currency: 'BRL' },
      });
      expect(await waitingOnLock(database.superuserUrl, database.name)).toBe(1);
      expect(await advisoryLocks(database.superuserUrl)).toBe(0);
      expect(await balanceOf(database.appUrl, walletA.id)).toBe('1000.00');

      await holder.query('COMMIT');
      holding = false;
      const onA = await blockedOnA;

      expect(onA.status).toBe(200);
      expect(await onA.json()).toMatchObject({ status: 'PROCESSED', kind: 'BET' });
      expect(await balanceOf(database.appUrl, walletA.id)).toBe('990.00');
      expect(await advisoryLocks(database.superuserUrl)).toBe(0);
    } finally {
      if (holding) {
        await holder.query('ROLLBACK');
      }
      await holder.end();
      await app.stop();
    }
  });
});
