import { beforeEach, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';

const CURRENCY = 'BRL';
const PROVIDER = 'provider-guards';
const SYSTEM_PROVIDER = '__system__';
const BET_EXTERNAL_ID = 'bet-1';
const PENDING_EXTERNAL_ID = 'rollback-pending';
const GUARDED_TABLES = [
  'wallets',
  'house_accounts',
  'wager_transactions',
  'ledger_entries',
  'idempotency_records',
] as const;

interface Ledger {
  readonly database: TestDatabase;
  readonly walletId: string;
  readonly playerId: string;
  readonly fundingId: string;
  readonly gamingId: string;
  readonly openingId: string;
  readonly betId: string;
  readonly pendingId: string;
}

interface NewTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalId: string;
  readonly kind: string;
  readonly amount: string;
  readonly status: string;
  readonly failureCode: string | null;
  readonly referenceExternalId: string | null;
  readonly referenceTransactionId: string | null;
}

interface WalletLeg {
  readonly direction: string;
  readonly amount: string;
  readonly before: string;
  readonly after: string;
  readonly version: number;
}

interface HouseLeg {
  readonly houseAccountId: string;
  readonly direction: string;
  readonly amount: string;
}

type Work = (client: Client) => Promise<unknown>;

const withClient = async <T>(url: string, work: (client: Client) => Promise<T>): Promise<T> => {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
};

const inTransaction = (url: string, work: Work): Promise<void> =>
  withClient(url, async (client) => {
    await client.query('BEGIN');
    try {
      await work(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });

const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

const processedTransaction = (
  kind: string,
  amount: string,
  overrides: Partial<NewTransaction> = {},
): NewTransaction => ({
  id: crypto.randomUUID(),
  providerId: PROVIDER,
  externalId: `${kind.toLowerCase()}-${crypto.randomUUID()}`,
  kind,
  amount,
  status: 'PROCESSED',
  failureCode: null,
  referenceExternalId: null,
  referenceTransactionId: null,
  ...overrides,
});

const insertTransaction = (
  client: Client,
  ledger: Pick<Ledger, 'walletId' | 'playerId'>,
  transaction: NewTransaction,
): Promise<unknown> =>
  client.query(
    `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
       wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
       reference_transaction_id, status, failure_code, correlation_id, created_at, processed_at, updated_at)
     VALUES ($1, $2, $3, $3, repeat('a', 64), $4, $5, 'round-1', 'game-1', $6, $7, $8, $9, $10, $11::text,
       $12, 'correlation-1', now(), CASE WHEN $11::text = 'PROCESSED' THEN now() END, now())`,
    [
      transaction.id,
      transaction.providerId,
      transaction.externalId,
      ledger.walletId,
      ledger.playerId,
      transaction.kind,
      transaction.amount,
      CURRENCY,
      transaction.referenceExternalId,
      transaction.referenceTransactionId,
      transaction.status,
      transaction.failureCode,
    ],
  );

const insertWalletLeg = (
  client: Client,
  walletId: string,
  transactionId: string,
  leg: WalletLeg,
): Promise<unknown> =>
  client.query(
    `INSERT INTO ledger_entries (id, transaction_id, account_kind, wallet_id, direction, amount, currency,
       balance_before, balance_after, wallet_version, created_at)
     VALUES ($1, $2, 'WALLET', $3, $4, $5, $6, $7, $8, $9, now())`,
    [
      crypto.randomUUID(),
      transactionId,
      walletId,
      leg.direction,
      leg.amount,
      CURRENCY,
      leg.before,
      leg.after,
      leg.version,
    ],
  );

const insertHouseLeg = (client: Client, transactionId: string, leg: HouseLeg): Promise<unknown> =>
  client.query(
    `INSERT INTO ledger_entries (id, transaction_id, account_kind, house_account_id, direction, amount, currency,
       created_at)
     VALUES ($1, $2, 'HOUSE', $3, $4, $5, $6, now())`,
    [crypto.randomUUID(), transactionId, leg.houseAccountId, leg.direction, leg.amount, CURRENCY],
  );

const setWallet = (
  client: Client,
  walletId: string,
  balance: string,
  version: number,
): Promise<unknown> =>
  client.query(`UPDATE wallets SET balance = $2, version = $3, updated_at = now() WHERE id = $1`, [
    walletId,
    balance,
    version,
  ]);

const insertIdempotencyRecord = (
  client: Client,
  idempotencyKey: string,
  transactionId: string,
  httpStatus: number,
): Promise<unknown> =>
  client.query(
    `INSERT INTO idempotency_records (provider_id, idempotency_key, payload_hash, transaction_id, http_status,
       response_body, created_at, updated_at)
     VALUES ($1, $2, repeat('a', 64), $3, $4, '{}'::jsonb, now(), now())`,
    [PROVIDER, idempotencyKey, transactionId, httpStatus],
  );

const applyMovement = async (
  client: Client,
  ledger: Ledger,
  transaction: NewTransaction,
  walletLeg: WalletLeg,
  houseLeg: HouseLeg,
): Promise<void> => {
  await insertTransaction(client, ledger, transaction);
  await insertWalletLeg(client, ledger.walletId, transaction.id, walletLeg);
  await insertHouseLeg(client, transaction.id, houseLeg);
  await setWallet(client, ledger.walletId, walletLeg.after, walletLeg.version);
};

const betDebit = (version: number, before: string, after: string, amount: string): WalletLeg => ({
  direction: 'DEBIT',
  amount,
  before,
  after,
  version,
});

const seedLedger = async (): Promise<Ledger> => {
  const database = await createTestDatabase();
  const ledger: Ledger = {
    database,
    walletId: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    fundingId: crypto.randomUUID(),
    gamingId: crypto.randomUUID(),
    openingId: crypto.randomUUID(),
    betId: crypto.randomUUID(),
    pendingId: crypto.randomUUID(),
  };
  await inTransaction(database.ownerUrl, async (client) => {
    await client.query(
      `INSERT INTO house_accounts (id, currency, purpose, created_at)
       VALUES ($1, $3, 'FUNDING', now()), ($2, $3, 'GAMING', now())`,
      [ledger.fundingId, ledger.gamingId, CURRENCY],
    );
    await client.query(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES ($1, $2, $3, '100.00', 1, now(), now())`,
      [ledger.walletId, ledger.playerId, CURRENCY],
    );
    await insertTransaction(
      client,
      ledger,
      processedTransaction('OPENING', '100.00', {
        id: ledger.openingId,
        providerId: SYSTEM_PROVIDER,
        externalId: `opening-${ledger.walletId}`,
      }),
    );
    await insertWalletLeg(client, ledger.walletId, ledger.openingId, {
      direction: 'CREDIT',
      amount: '100.00',
      before: '0.00',
      after: '100.00',
      version: 1,
    });
    await insertHouseLeg(client, ledger.openingId, {
      houseAccountId: ledger.fundingId,
      direction: 'DEBIT',
      amount: '100.00',
    });
  });
  await inTransaction(database.ownerUrl, (client) =>
    applyMovement(
      client,
      ledger,
      processedTransaction('BET', '30.00', { id: ledger.betId, externalId: BET_EXTERNAL_ID }),
      betDebit(2, '100.00', '70.00', '30.00'),
      { houseAccountId: ledger.gamingId, direction: 'CREDIT', amount: '30.00' },
    ),
  );
  await inTransaction(database.ownerUrl, async (client) => {
    await insertIdempotencyRecord(client, BET_EXTERNAL_ID, ledger.betId, 200);
    await insertTransaction(
      client,
      ledger,
      processedTransaction('ROLLBACK', '30.00', {
        id: ledger.pendingId,
        externalId: PENDING_EXTERNAL_ID,
        status: 'PENDING_REFERENCE',
        referenceExternalId: BET_EXTERNAL_ID,
      }),
    );
    await insertIdempotencyRecord(client, PENDING_EXTERNAL_ID, ledger.pendingId, 202);
  });
  return ledger;
};

const snapshot = (database: TestDatabase): Promise<Record<string, string[]>> =>
  withClient(database.superuserUrl, async (client) => {
    const tables: Record<string, string[]> = {};
    for (const table of GUARDED_TABLES) {
      const result = await client.query<{ row: string }>(
        `SELECT to_jsonb(t)::text AS row FROM ${table} t ORDER BY 1`,
      );
      tables[table] = result.rows.map((row) => row.row);
    }
    return tables;
  });

const expectRefused = async (ledger: Ledger, code: string, work: Work): Promise<void> => {
  const before = await snapshot(ledger.database);
  const failure = await rejection(inTransaction(ledger.database.ownerUrl, work));
  expect(failure).toMatchObject({ code });
  expect(await snapshot(ledger.database)).toEqual(before);
};

const walletState = (ledger: Ledger): Promise<{ balance: string; version: number } | undefined> =>
  withClient(ledger.database.superuserUrl, async (client) => {
    const result = await client.query<{ balance: string; version: number }>(
      'SELECT balance::text AS balance, version FROM wallets WHERE id = $1',
      [ledger.walletId],
    );
    return result.rows[0];
  });

const scalar = (ledger: Ledger, sql: string, values: readonly unknown[]): Promise<unknown> =>
  withClient(ledger.database.superuserUrl, async (client) => {
    const result = await client.query<{ value: unknown }>(sql, [...values]);
    return result.rows[0]?.value;
  });

const entryCount = (ledger: Ledger, transactionId: string): Promise<unknown> =>
  scalar(ledger, 'SELECT count(*)::int AS value FROM ledger_entries WHERE transaction_id = $1', [
    transactionId,
  ]);

const resolvePendingRollback = async (client: Client, ledger: Ledger): Promise<void> => {
  await client.query(
    `UPDATE wager_transactions
     SET status = 'PROCESSED', reference_transaction_id = $2, processed_at = now(),
       balance_snapshot_amount = '100.00', balance_snapshot_currency = $3, updated_at = now()
     WHERE id = $1`,
    [ledger.pendingId, ledger.betId, CURRENCY],
  );
  await insertWalletLeg(client, ledger.walletId, ledger.pendingId, {
    direction: 'CREDIT',
    amount: '30.00',
    before: '70.00',
    after: '100.00',
    version: 3,
  });
  await insertHouseLeg(client, ledger.pendingId, {
    houseAccountId: ledger.gamingId,
    direction: 'DEBIT',
    amount: '30.00',
  });
  await setWallet(client, ledger.walletId, '100.00', 3);
};

const rollbackOfBet = (ledger: Ledger): NewTransaction =>
  processedTransaction('ROLLBACK', '30.00', {
    referenceExternalId: BET_EXTERNAL_ID,
    referenceTransactionId: ledger.betId,
  });

describe('database guards', () => {
  let ledger: Ledger;

  beforeEach(async () => {
    ledger = await seedLedger();
  });

  describe('allowed paths', () => {
    it('accepts an OPENING that funds the wallet from the funding account', async () => {
      expect(await entryCount(ledger, ledger.openingId)).toBe(2);
      expect(
        await scalar(
          ledger,
          `SELECT house_account_id AS value FROM ledger_entries
           WHERE transaction_id = $1 AND account_kind = 'HOUSE'`,
          [ledger.openingId],
        ),
      ).toBe(ledger.fundingId);
    });

    it('accepts a BET that debits the wallet against the gaming account', async () => {
      expect(await entryCount(ledger, ledger.betId)).toBe(2);
      expect(await walletState(ledger)).toEqual({ balance: '70.00', version: 2 });
    });

    it('accepts a ROLLBACK of a BET that credits the wallet back', async () => {
      const rollback = rollbackOfBet(ledger);
      await inTransaction(ledger.database.ownerUrl, (client) =>
        applyMovement(
          client,
          ledger,
          rollback,
          { direction: 'CREDIT', amount: '30.00', before: '70.00', after: '100.00', version: 3 },
          { houseAccountId: ledger.gamingId, direction: 'DEBIT', amount: '30.00' },
        ),
      );
      expect(await entryCount(ledger, rollback.id)).toBe(2);
      expect(await walletState(ledger)).toEqual({ balance: '100.00', version: 3 });
    });

    it('accepts resolving a pending transaction as processed with its ledger entries', async () => {
      await inTransaction(ledger.database.ownerUrl, (client) =>
        resolvePendingRollback(client, ledger),
      );
      expect(
        await scalar(ledger, 'SELECT status AS value FROM wager_transactions WHERE id = $1', [
          ledger.pendingId,
        ]),
      ).toBe('PROCESSED');
      expect(await walletState(ledger)).toEqual({ balance: '100.00', version: 3 });
    });

    it('accepts resolving a pending transaction as rejected', async () => {
      await inTransaction(ledger.database.ownerUrl, (client) =>
        client.query(
          `UPDATE wager_transactions
           SET status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND', updated_at = now()
           WHERE id = $1`,
          [ledger.pendingId],
        ),
      );
      expect(
        await scalar(ledger, 'SELECT failure_code AS value FROM wager_transactions WHERE id = $1', [
          ledger.pendingId,
        ]),
      ).toBe('REFERENCE_NOT_FOUND');
    });

    it('accepts resolving a 202 idempotency record to 200', async () => {
      await inTransaction(ledger.database.ownerUrl, (client) =>
        client.query(
          `UPDATE idempotency_records
           SET http_status = 200, response_body = '{"status":"PROCESSED"}'::jsonb, updated_at = now()
           WHERE provider_id = $1 AND idempotency_key = $2`,
          [PROVIDER, PENDING_EXTERNAL_ID],
        ),
      );
      expect(
        await scalar(
          ledger,
          `SELECT http_status AS value FROM idempotency_records
           WHERE provider_id = $1 AND idempotency_key = $2`,
          [PROVIDER, PENDING_EXTERNAL_ID],
        ),
      ).toBe(200);
    });
  });

  describe('JG001 ledger is append-only', () => {
    it('refuses an UPDATE on a ledger entry', () =>
      expectRefused(ledger, 'JG001', (client) =>
        client.query('UPDATE ledger_entries SET created_at = now() WHERE transaction_id = $1', [
          ledger.betId,
        ]),
      ));

    it('refuses a DELETE of a ledger entry', () =>
      expectRefused(ledger, 'JG001', (client) =>
        client.query('DELETE FROM ledger_entries WHERE transaction_id = $1', [ledger.betId]),
      ));

    it('refuses a TRUNCATE of the ledger', () =>
      expectRefused(ledger, 'JG001', (client) => client.query('TRUNCATE ledger_entries')));
  });

  describe('JG002 wallet balance follows the ledger', () => {
    it('refuses a wallet opened with balance and no opening entry', () =>
      expectRefused(ledger, 'JG002', (client) =>
        client.query(
          `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
           VALUES ($1, $2, $3, '50.00', 1, now(), now())`,
          [crypto.randomUUID(), crypto.randomUUID(), CURRENCY],
        ),
      ));

    it('refuses a wallet that starts above version 1', () =>
      expectRefused(ledger, 'JG002', (client) =>
        client.query(
          `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
           VALUES ($1, $2, $3, '0.00', 2, now(), now())`,
          [crypto.randomUUID(), crypto.randomUUID(), CURRENCY],
        ),
      ));

    it('refuses a balance change without a ledger entry', () =>
      expectRefused(ledger, 'JG002', (client) => setWallet(client, ledger.walletId, '80.00', 3)));

    it('refuses a version that skips ahead', () =>
      expectRefused(ledger, 'JG002', (client) =>
        applyMovement(
          client,
          ledger,
          processedTransaction('BET', '30.00'),
          betDebit(4, '70.00', '40.00', '30.00'),
          { houseAccountId: ledger.gamingId, direction: 'CREDIT', amount: '30.00' },
        ),
      ));

    it('refuses a version change without a balance change', () =>
      expectRefused(ledger, 'JG002', (client) => setWallet(client, ledger.walletId, '70.00', 3)));

    it('refuses a change to the wallet identity', () =>
      expectRefused(ledger, 'JG002', (client) =>
        client.query('UPDATE wallets SET player_id = $2 WHERE id = $1', [
          ledger.walletId,
          crypto.randomUUID(),
        ]),
      ));
  });

  describe('JG003 ledger entry matches its transaction and wallet', () => {
    it('refuses an orphan entry for a transaction that was not processed', () =>
      expectRefused(ledger, 'JG003', (client) =>
        applyMovement(
          client,
          ledger,
          processedTransaction('BET', '30.00', {
            status: 'REJECTED',
            failureCode: 'INSUFFICIENT_FUNDS',
          }),
          betDebit(3, '70.00', '40.00', '30.00'),
          { houseAccountId: ledger.gamingId, direction: 'CREDIT', amount: '30.00' },
        ),
      ));

    it('refuses an entry for a LOSS', () =>
      expectRefused(ledger, 'JG003', (client) =>
        applyMovement(
          client,
          ledger,
          processedTransaction('LOSS', '10.00'),
          betDebit(3, '70.00', '60.00', '10.00'),
          { houseAccountId: ledger.gamingId, direction: 'CREDIT', amount: '10.00' },
        ),
      ));

    it('refuses an entry ahead of the wallet version', () =>
      expectRefused(ledger, 'JG003', async (client) => {
        const bet = processedTransaction('BET', '30.00');
        await insertTransaction(client, ledger, bet);
        await insertWalletLeg(
          client,
          ledger.walletId,
          bet.id,
          betDebit(3, '70.00', '40.00', '30.00'),
        );
        await insertHouseLeg(client, bet.id, {
          houseAccountId: ledger.gamingId,
          direction: 'CREDIT',
          amount: '30.00',
        });
      }));
  });

  describe('JG004 every transaction is a balanced double entry', () => {
    it('refuses a transaction without its house leg', () =>
      expectRefused(ledger, 'JG004', async (client) => {
        const bet = processedTransaction('BET', '30.00');
        await insertTransaction(client, ledger, bet);
        await insertWalletLeg(
          client,
          ledger.walletId,
          bet.id,
          betDebit(3, '70.00', '40.00', '30.00'),
        );
        await setWallet(client, ledger.walletId, '40.00', 3);
      }));

    it('refuses legs that do not sum to zero', () =>
      expectRefused(ledger, 'JG004', (client) =>
        applyMovement(
          client,
          ledger,
          processedTransaction('BET', '30.00'),
          betDebit(3, '70.00', '40.00', '30.00'),
          { houseAccountId: ledger.gamingId, direction: 'DEBIT', amount: '30.00' },
        ),
      ));

    it('refuses a BET booked against the funding account', () =>
      expectRefused(ledger, 'JG004', (client) =>
        applyMovement(
          client,
          ledger,
          processedTransaction('BET', '30.00'),
          betDebit(3, '70.00', '40.00', '30.00'),
          { houseAccountId: ledger.fundingId, direction: 'CREDIT', amount: '30.00' },
        ),
      ));

    it('refuses a ROLLBACK of a BET that debits the wallet again', () =>
      expectRefused(ledger, 'JG004', (client) =>
        applyMovement(
          client,
          ledger,
          rollbackOfBet(ledger),
          betDebit(3, '70.00', '40.00', '30.00'),
          { houseAccountId: ledger.gamingId, direction: 'CREDIT', amount: '30.00' },
        ),
      ));
  });

  describe('JG005 terminal transactions are immutable', () => {
    it('refuses an UPDATE on a terminal transaction', () =>
      expectRefused(ledger, 'JG005', (client) =>
        client.query(`UPDATE wager_transactions SET updated_at = now() WHERE id = $1`, [
          ledger.betId,
        ]),
      ));

    it('refuses a pending transaction that stays pending', () =>
      expectRefused(ledger, 'JG005', (client) =>
        client.query(`UPDATE wager_transactions SET updated_at = now() WHERE id = $1`, [
          ledger.pendingId,
        ]),
      ));

    it('refuses a pending resolution that changes a business column', () =>
      expectRefused(ledger, 'JG005', (client) =>
        client.query(
          `UPDATE wager_transactions
           SET status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND', amount = '31.00', updated_at = now()
           WHERE id = $1`,
          [ledger.pendingId],
        ),
      ));

    it('refuses a DELETE of a transaction', () =>
      expectRefused(ledger, 'JG005', (client) =>
        client.query('DELETE FROM wager_transactions WHERE id = $1', [ledger.betId]),
      ));

    it('refuses a TRUNCATE CASCADE of the transactions', () =>
      expectRefused(ledger, 'JG005', (client) =>
        client.query('TRUNCATE wager_transactions CASCADE'),
      ));

    it('has a plain TRUNCATE refused by the foreign keys first', () =>
      expectRefused(ledger, '0A000', (client) => client.query('TRUNCATE wager_transactions')));
  });

  describe('JG006 wallets are never removed', () => {
    it('refuses a DELETE of a wallet', () =>
      expectRefused(ledger, 'JG006', (client) =>
        client.query('DELETE FROM wallets WHERE id = $1', [ledger.walletId]),
      ));

    it('refuses a TRUNCATE CASCADE of the wallets', () =>
      expectRefused(ledger, 'JG006', (client) => client.query('TRUNCATE wallets CASCADE')));

    it('has a plain TRUNCATE refused by the foreign keys first', () =>
      expectRefused(ledger, '0A000', (client) => client.query('TRUNCATE wallets')));
  });

  describe('JG007 idempotency records only change from 202', () => {
    it('refuses an UPDATE on a record that is already 200', () =>
      expectRefused(ledger, 'JG007', (client) =>
        client.query(
          `UPDATE idempotency_records SET response_body = '{}'::jsonb, updated_at = now()
           WHERE provider_id = $1 AND idempotency_key = $2`,
          [PROVIDER, BET_EXTERNAL_ID],
        ),
      ));

    it('refuses resolving a 202 record to a status other than 200, 422 or 500', () =>
      expectRefused(ledger, 'JG007', (client) =>
        client.query(
          `UPDATE idempotency_records SET http_status = 409, updated_at = now()
           WHERE provider_id = $1 AND idempotency_key = $2`,
          [PROVIDER, PENDING_EXTERNAL_ID],
        ),
      ));

    it('refuses a change to the identity of a 202 record', () =>
      expectRefused(ledger, 'JG007', (client) =>
        client.query(
          `UPDATE idempotency_records SET http_status = 200, payload_hash = repeat('b', 64)
           WHERE provider_id = $1 AND idempotency_key = $2`,
          [PROVIDER, PENDING_EXTERNAL_ID],
        ),
      ));

    it('refuses a DELETE of a record', () =>
      expectRefused(ledger, 'JG007', (client) =>
        client.query('DELETE FROM idempotency_records WHERE provider_id = $1', [PROVIDER]),
      ));

    it('refuses a TRUNCATE of the records', () =>
      expectRefused(ledger, 'JG007', (client) => client.query('TRUNCATE idempotency_records')));
  });
});
