import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { currentDatabaseUrl } from '@test/support/current-database';
import {
  breakLedgerWrites,
  breakOutboxWrites,
  restoreGrants,
} from '@test/support/deterministic-failure';
import {
  LedgerConsistencyError,
  MissingSkipReasonError,
  assertLedgerConsistency,
  ledgerConsistencyAfterEach,
  skipLedgerConsistency,
} from '@test/support/ledger-consistency';
import { APP_ROLE, createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';

const CURRENCY = 'BRL';
const PROVIDER = 'provider-consistency';

const withClient = async <T>(url: string, work: (client: Client) => Promise<T>): Promise<T> => {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
};

const inTransaction = (url: string, statements: (client: Client) => Promise<void>): Promise<void> =>
  withClient(url, async (client) => {
    await client.query('BEGIN');
    try {
      await statements(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });

const insertTransaction = (
  client: Client,
  values: { id: string; walletId: string; playerId: string; kind: string; amount: string },
): Promise<unknown> =>
  client.query(
    `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
       wallet_id, player_id, round_id, game_id, kind, amount, currency, status, correlation_id,
       created_at, processed_at, updated_at)
     VALUES ($1, $2, $3, $3, repeat('a', 64), $4, $5, 'round-1', 'game-1', $6, $7, $8, 'PROCESSED',
       'correlation-1', now(), now(), now())`,
    [
      values.id,
      values.kind === 'OPENING' ? '__system__' : PROVIDER,
      `external-${values.id}`,
      values.walletId,
      values.playerId,
      values.kind,
      values.amount,
      CURRENCY,
    ],
  );

const insertWalletEntry = (
  client: Client,
  values: {
    transactionId: string;
    walletId: string;
    direction: string;
    amount: string;
    before: string;
    after: string;
    version: number;
  },
): Promise<unknown> =>
  client.query(
    `INSERT INTO ledger_entries (id, transaction_id, account_kind, wallet_id, direction, amount, currency,
       balance_before, balance_after, wallet_version, created_at)
     VALUES ($1, $2, 'WALLET', $3, $4, $5, $6, $7, $8, $9, now())`,
    [
      crypto.randomUUID(),
      values.transactionId,
      values.walletId,
      values.direction,
      values.amount,
      CURRENCY,
      values.before,
      values.after,
      values.version,
    ],
  );

const insertHouseEntry = (
  client: Client,
  values: { transactionId: string; houseAccountId: string; direction: string; amount: string },
): Promise<unknown> =>
  client.query(
    `INSERT INTO ledger_entries (id, transaction_id, account_kind, house_account_id, direction, amount, currency,
       created_at)
     VALUES ($1, $2, 'HOUSE', $3, $4, $5, $6, now())`,
    [
      crypto.randomUUID(),
      values.transactionId,
      values.houseAccountId,
      values.direction,
      values.amount,
      CURRENCY,
    ],
  );

const seedWalletWithOpeningAndBet = async (database: TestDatabase): Promise<string> => {
  const walletId = crypto.randomUUID();
  const playerId = crypto.randomUUID();
  const fundingId = crypto.randomUUID();
  const gamingId = crypto.randomUUID();
  const openingId = crypto.randomUUID();
  const betId = crypto.randomUUID();
  await inTransaction(database.superuserUrl, async (client) => {
    await client.query(
      `INSERT INTO house_accounts (id, currency, purpose, created_at)
       VALUES ($1, $3, 'FUNDING', now()), ($2, $3, 'GAMING', now())`,
      [fundingId, gamingId, CURRENCY],
    );
    await client.query(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES ($1, $2, $3, '100.00', 1, now(), now())`,
      [walletId, playerId, CURRENCY],
    );
    await insertTransaction(client, {
      id: openingId,
      walletId,
      playerId,
      kind: 'OPENING',
      amount: '100.00',
    });
    await insertWalletEntry(client, {
      transactionId: openingId,
      walletId,
      direction: 'CREDIT',
      amount: '100.00',
      before: '0.00',
      after: '100.00',
      version: 1,
    });
    await insertHouseEntry(client, {
      transactionId: openingId,
      houseAccountId: fundingId,
      direction: 'DEBIT',
      amount: '100.00',
    });
  });
  await inTransaction(database.superuserUrl, async (client) => {
    await insertTransaction(client, {
      id: betId,
      walletId,
      playerId,
      kind: 'BET',
      amount: '30.00',
    });
    await insertWalletEntry(client, {
      transactionId: betId,
      walletId,
      direction: 'DEBIT',
      amount: '30.00',
      before: '100.00',
      after: '70.00',
      version: 2,
    });
    await insertHouseEntry(client, {
      transactionId: betId,
      houseAccountId: gamingId,
      direction: 'CREDIT',
      amount: '30.00',
    });
    await client.query(
      `UPDATE wallets SET balance = '70.00', version = 2, updated_at = now() WHERE id = $1`,
      [walletId],
    );
  });
  return walletId;
};

const corruptWalletBalance = (database: TestDatabase, walletId: string): Promise<void> =>
  inTransaction(database.superuserUrl, async (client) => {
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(`UPDATE wallets SET balance = '71.00' WHERE id = $1`, [walletId]);
  });

const createCorruptedDatabase = async (): Promise<{ database: TestDatabase; walletId: string }> => {
  const database = await createTestDatabase();
  const walletId = await seedWalletWithOpeningAndBet(database);
  await corruptWalletBalance(database, walletId);
  return { database, walletId };
};

const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

const appCanInsert = (database: TestDatabase, table: string): Promise<boolean> =>
  withClient(database.superuserUrl, async (client) => {
    const result = await client.query<{ allowed: boolean }>(
      'SELECT has_table_privilege($1, $2, $3) AS allowed',
      [APP_ROLE, table, 'INSERT'],
    );
    return result.rows[0]?.allowed === true;
  });

describe('ledger consistency check', () => {
  it('passes on a consistent database', async () => {
    const database = await createTestDatabase();
    await seedWalletWithOpeningAndBet(database);
    await assertLedgerConsistency(database.superuserUrl);
    expect(currentDatabaseUrl()).toBe(database.superuserUrl);
  });

  it('fails when a wallet balance no longer matches its ledger', async () => {
    const { database, walletId } = await createCorruptedDatabase();
    const failure = await rejection(assertLedgerConsistency(database.superuserUrl));
    expect(failure).toBeInstanceOf(LedgerConsistencyError);
    const problems = failure instanceof LedgerConsistencyError ? failure.problems : [];
    expect(problems).toEqual([
      `wallet ${walletId}: balance differs from the sum of its ledger entries`,
      `wallet ${walletId}: invalid chain from version 2 (LAST_BALANCE_MISMATCH)`,
      `currency ${CURRENCY}: wallets and house accounts do not sum to zero`,
    ]);
    skipLedgerConsistency('the wallet is corrupted on purpose');
  });

  it('passes a corrupted database when the current test skips the check', async () => {
    await createCorruptedDatabase();
    skipLedgerConsistency('the wallet is corrupted on purpose');
    await ledgerConsistencyAfterEach()();
    expect(currentDatabaseUrl()).toBeUndefined();
  });

  it('does not carry a skip over to the next test', async () => {
    await createCorruptedDatabase();
    const failure = await rejection(ledgerConsistencyAfterEach()());
    expect(failure).toBeInstanceOf(LedgerConsistencyError);
    expect(currentDatabaseUrl()).toBeUndefined();
  });

  it('requires a reason to skip', () => {
    expect(() => {
      skipLedgerConsistency(' ');
    }).toThrow(MissingSkipReasonError);
  });

  it('waits for an active outbox lease to expire before checking', async () => {
    const database = await createTestDatabase();
    await withClient(database.superuserUrl, (client) =>
      client.query(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at,
           locked_until, locked_by)
         VALUES ($1, $2, 'WalletBalanceChanged', '{}'::jsonb, now(), now(),
           now() + interval '400 milliseconds', 'instance-a')`,
        [crypto.randomUUID(), crypto.randomUUID()],
      ),
    );
    const started = performance.now();
    await assertLedgerConsistency(database.superuserUrl);
    expect(performance.now() - started).toBeGreaterThanOrEqual(300);
  });
});

describe('deterministic failure helpers', () => {
  it('revokes and restores insert on ledger_entries and outbox_messages for jungle_app', async () => {
    const database = await createTestDatabase();
    await breakLedgerWrites(database);
    expect(await appCanInsert(database, 'ledger_entries')).toBe(false);
    expect(await appCanInsert(database, 'outbox_messages')).toBe(true);
    await breakOutboxWrites(database);
    expect(await appCanInsert(database, 'outbox_messages')).toBe(false);
    await restoreGrants(database);
    expect(await appCanInsert(database, 'ledger_entries')).toBe(true);
    expect(await appCanInsert(database, 'outbox_messages')).toBe(true);
  });

  it('makes a jungle_app insert into ledger_entries fail with 42501', async () => {
    const database = await createTestDatabase();
    await breakLedgerWrites(database);
    const failure = await rejection(
      withClient(database.appUrl, (client) =>
        client.query(
          `INSERT INTO ledger_entries (id, transaction_id, account_kind, house_account_id, direction,
             amount, currency, created_at)
           VALUES ($1, $2, 'HOUSE', $3, 'DEBIT', '1.00', 'BRL', now())`,
          [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()],
        ),
      ),
    );
    expect(failure).toMatchObject({ code: '42501' });
    await restoreGrants(database);
  });
});
