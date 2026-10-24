import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import type { CurrencySums } from '@application/ports/repositories/reconciliation-repository.port';
import { Money } from '@domain/shared/money';
import { LedgerDirection } from '@domain/wallet/ledger-direction';
import { loadConfig } from '@infrastructure/config/env.schema';
import { MikroOrmUnitOfWork } from '@infrastructure/persistence/mikro-orm-unit-of-work';
import { closeOrmInstances, openOrmInstances } from '@infrastructure/persistence/orm-instances';
import type { OrmInstances } from '@infrastructure/persistence/orm-instances';
import { skipLedgerConsistency } from '@test/support/ledger-consistency';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';

const SYSTEM_PROVIDER = '__system__';
const PROVIDER = 'provider-reconciliation';

const IDS = {
  brlFunding: '0198b000-0000-7000-8000-0000000000f1',
  brlGaming: '0198b000-0000-7000-8000-0000000000f2',
  usdFunding: '0198b000-0000-7000-8000-0000000000f3',
  usdGaming: '0198b000-0000-7000-8000-0000000000f4',
  walletA: '0198b000-0000-7000-8000-00000000000a',
  walletB: '0198b000-0000-7000-8000-00000000000b',
  walletC: '0198b000-0000-7000-8000-00000000000c',
  missingWallet: '0198b000-0000-7000-8000-0000000000ff',
  walletRun: '0198b000-0000-7000-8000-0000000000e1',
  globalRun: '0198b000-0000-7000-8000-0000000000e2',
} as const;

const STARTED_AT = new Date('2026-10-24T12:00:00.000Z');
const FINISHED_AT = new Date('2026-10-24T12:00:01.500Z');

interface Movement {
  readonly walletId: string;
  readonly playerId: string;
  readonly currency: string;
  readonly kind: string;
  readonly providerId: string;
  readonly amount: string;
  readonly walletDirection: LedgerDirection;
  readonly houseAccountId: string;
  readonly before: string;
  readonly after: string;
  readonly version: number;
}

interface StoredRun {
  readonly id: string;
  readonly scope: string;
  readonly wallet_id: string | null;
  readonly consistent: boolean;
  readonly checked_entries: number;
  readonly stored_amount: string | null;
  readonly calculated_amount: string | null;
  readonly difference_amount: string | null;
  readonly currency: string | null;
  readonly first_divergent_version: number | null;
  readonly details: unknown;
  readonly started_at: string;
  readonly finished_at: string;
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

const inTransaction = (url: string, work: (client: Client) => Promise<void>): Promise<void> =>
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

const opposite = (direction: LedgerDirection): LedgerDirection =>
  direction === LedgerDirection.Credit ? LedgerDirection.Debit : LedgerDirection.Credit;

const insertMovement = async (client: Client, movement: Movement): Promise<void> => {
  const transactionId = crypto.randomUUID();
  const externalId = `${movement.kind.toLowerCase()}-${transactionId}`;
  await client.query(
    `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
       wallet_id, player_id, round_id, game_id, kind, amount, currency, status, correlation_id,
       created_at, processed_at, updated_at)
     VALUES ($1, $2, $3, $3, repeat('a', 64), $4, $5, 'round-1', 'game-1', $6, $7, $8, 'PROCESSED',
       'correlation-1', now(), now(), now())`,
    [
      transactionId,
      movement.providerId,
      externalId,
      movement.walletId,
      movement.playerId,
      movement.kind,
      movement.amount,
      movement.currency,
    ],
  );
  await client.query(
    `INSERT INTO ledger_entries (id, transaction_id, account_kind, wallet_id, direction, amount, currency,
       balance_before, balance_after, wallet_version, created_at)
     VALUES ($1, $2, 'WALLET', $3, $4, $5, $6, $7, $8, $9, now())`,
    [
      crypto.randomUUID(),
      transactionId,
      movement.walletId,
      movement.walletDirection,
      movement.amount,
      movement.currency,
      movement.before,
      movement.after,
      movement.version,
    ],
  );
  await client.query(
    `INSERT INTO ledger_entries (id, transaction_id, account_kind, house_account_id, direction, amount, currency,
       created_at)
     VALUES ($1, $2, 'HOUSE', $3, $4, $5, $6, now())`,
    [
      crypto.randomUUID(),
      transactionId,
      movement.houseAccountId,
      opposite(movement.walletDirection),
      movement.amount,
      movement.currency,
    ],
  );
};

const openWallet = async (
  client: Client,
  walletId: string,
  currency: string,
  fundingId: string,
  balance: string,
): Promise<string> => {
  const playerId = crypto.randomUUID();
  await client.query(
    `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 1, now(), now())`,
    [walletId, playerId, currency, balance],
  );
  if (balance !== '0.00') {
    await insertMovement(client, {
      walletId,
      playerId,
      currency,
      kind: 'OPENING',
      providerId: SYSTEM_PROVIDER,
      amount: balance,
      walletDirection: LedgerDirection.Credit,
      houseAccountId: fundingId,
      before: '0.00',
      after: balance,
      version: 1,
    });
  }
  return playerId;
};

const placeBet = async (client: Client, movement: Omit<Movement, 'kind'>): Promise<void> => {
  await insertMovement(client, { ...movement, kind: 'BET' });
  await client.query(
    'UPDATE wallets SET balance = $2, version = $3, updated_at = now() WHERE id = $1',
    [movement.walletId, movement.after, movement.version],
  );
};

const seed = async (database: TestDatabase): Promise<string> => {
  let playerA = '';
  await inTransaction(database.ownerUrl, async (client) => {
    await client.query(
      `INSERT INTO house_accounts (id, currency, purpose, created_at)
       VALUES ($1, 'BRL', 'FUNDING', now()), ($2, 'BRL', 'GAMING', now()),
              ($3, 'USD', 'FUNDING', now()), ($4, 'USD', 'GAMING', now())`,
      [IDS.brlFunding, IDS.brlGaming, IDS.usdFunding, IDS.usdGaming],
    );
    playerA = await openWallet(client, IDS.walletA, 'BRL', IDS.brlFunding, '100.00');
    await openWallet(client, IDS.walletB, 'BRL', IDS.brlFunding, '0.00');
    await openWallet(client, IDS.walletC, 'USD', IDS.usdFunding, '50.00');
  });
  await inTransaction(database.ownerUrl, (client) =>
    placeBet(client, {
      walletId: IDS.walletA,
      playerId: playerA,
      currency: 'BRL',
      providerId: PROVIDER,
      amount: '30.00',
      walletDirection: LedgerDirection.Debit,
      houseAccountId: IDS.brlGaming,
      before: '100.00',
      after: '70.00',
      version: 2,
    }),
  );
  return playerA;
};

const corrupt = (database: TestDatabase, sql: string, values: readonly unknown[]): Promise<void> =>
  inTransaction(database.superuserUrl, async (client) => {
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(sql, [...values]);
  });

const storedRuns = (database: TestDatabase): Promise<StoredRun[]> =>
  withClient(database.superuserUrl, async (client) => {
    const result = await client.query<StoredRun>(
      `SELECT id, scope, wallet_id, consistent, checked_entries,
              stored_amount::text AS stored_amount, calculated_amount::text AS calculated_amount,
              difference_amount::text AS difference_amount, currency, first_divergent_version, details,
              to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS started_at,
              to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS finished_at
       FROM reconciliation_runs
       ORDER BY id`,
    );
    return result.rows;
  });

const byCurrency = (sums: readonly CurrencySums[]): CurrencySums[] =>
  [...sums].sort((left, right) => left.currency.localeCompare(right.currency));

describe('MikroOrmReconciliationRepository', () => {
  let database: TestDatabase;
  let instances: OrmInstances;
  let uow: MikroOrmUnitOfWork;
  let playerA: string;

  beforeEach(async () => {
    database = await createTestDatabase();
    playerA = await seed(database);
    const config = loadConfig({ DATABASE_URL: database.appUrl }, { role: 'api' });
    instances = await openOrmInstances(config);
    uow = new MikroOrmUnitOfWork(instances, config);
  });

  afterEach(async () => {
    await closeOrmInstances(instances);
  });

  describe('walletSnapshot', () => {
    it('reads the wallet, its totals and its chain ordered by version', async () => {
      const snapshot = await uow.run('reconciliation', (repos) =>
        repos.reconciliation.walletSnapshot(IDS.walletA),
      );
      expect(snapshot).toEqual({
        walletId: IDS.walletA,
        currency: 'BRL',
        balance: '70.00',
        version: 2,
        credits: '100.00',
        debits: '30.00',
        entries: 2,
        chain: [
          {
            walletVersion: 1,
            direction: LedgerDirection.Credit,
            amount: '100.00',
            currency: 'BRL',
            balanceBefore: '0.00',
            balanceAfter: '100.00',
          },
          {
            walletVersion: 2,
            direction: LedgerDirection.Debit,
            amount: '30.00',
            currency: 'BRL',
            balanceBefore: '100.00',
            balanceAfter: '70.00',
          },
        ],
      });
    });

    it('returns zero totals and an empty chain for a wallet without entries', async () => {
      const snapshot = await uow.run('reconciliation', (repos) =>
        repos.reconciliation.walletSnapshot(IDS.walletB),
      );
      expect(snapshot).toEqual({
        walletId: IDS.walletB,
        currency: 'BRL',
        balance: '0.00',
        version: 1,
        credits: '0.00',
        debits: '0.00',
        entries: 0,
        chain: [],
      });
    });

    it('returns undefined for an unknown wallet', async () => {
      const snapshot = await uow.run('reconciliation', (repos) =>
        repos.reconciliation.walletSnapshot(IDS.missingWallet),
      );
      expect(snapshot).toBeUndefined();
    });

    it('keeps a single snapshot while other transactions commit', async () => {
      const seen = await uow.run('reconciliation', async (repos) => {
        const sums = await repos.reconciliation.globalSums();
        await inTransaction(database.ownerUrl, (client) =>
          placeBet(client, {
            walletId: IDS.walletA,
            playerId: playerA,
            currency: 'BRL',
            providerId: PROVIDER,
            amount: '20.00',
            walletDirection: LedgerDirection.Debit,
            houseAccountId: IDS.brlGaming,
            before: '70.00',
            after: '50.00',
            version: 3,
          }),
        );
        const snapshot = await repos.reconciliation.walletSnapshot(IDS.walletA);
        return { sums: byCurrency(sums), snapshot };
      });
      expect(seen.sums[0]?.walletsTotal).toBe('70.00');
      expect(seen.snapshot).toMatchObject({ balance: '70.00', version: 2, entries: 2 });
      const after = await uow.run('reconciliation', (repos) =>
        repos.reconciliation.walletSnapshot(IDS.walletA),
      );
      expect(after).toMatchObject({ balance: '50.00', version: 3, entries: 3, debits: '50.00' });
    });
  });

  describe('globalSums', () => {
    it('sums wallets, house accounts and the ledger per currency with signed values', async () => {
      const sums = await uow.run('reconciliation', (repos) => repos.reconciliation.globalSums());
      expect(byCurrency(sums)).toEqual([
        {
          currency: 'BRL',
          walletsTotal: '70.00',
          fundingBalance: '-100.00',
          gamingBalance: '30.00',
          ledgerNet: '0.00',
        },
        {
          currency: 'USD',
          walletsTotal: '50.00',
          fundingBalance: '-50.00',
          gamingBalance: '0.00',
          ledgerNet: '0.00',
        },
      ]);
    });
  });

  describe('walletBatch', () => {
    it('pages wallets by id starting from the first batch', async () => {
      const pages = await uow.run('reconciliation', async (repos) => {
        const first = await repos.reconciliation.walletBatch(undefined, 2);
        const second = await repos.reconciliation.walletBatch(first.at(-1)?.walletId, 2);
        const last = await repos.reconciliation.walletBatch(IDS.walletC, 2);
        return { first, second, last };
      });
      expect(pages.first).toEqual([
        {
          walletId: IDS.walletA,
          balance: '70.00',
          version: 2,
          calculated: '70.00',
          entries: 2,
          firstVersion: 1,
          lastVersion: 2,
        },
        {
          walletId: IDS.walletB,
          balance: '0.00',
          version: 1,
          calculated: '0.00',
          entries: 0,
          firstVersion: undefined,
          lastVersion: undefined,
        },
      ]);
      expect(pages.second).toEqual([
        {
          walletId: IDS.walletC,
          balance: '50.00',
          version: 1,
          calculated: '50.00',
          entries: 1,
          firstVersion: 1,
          lastVersion: 1,
        },
      ]);
      expect(pages.last).toEqual([]);
    });

    it('exposes a corrupted wallet with a negative calculated balance', async () => {
      skipLedgerConsistency('the opening entry of wallet A is deleted on purpose');
      await corrupt(
        database,
        `DELETE FROM ledger_entries WHERE wallet_id = $1 AND wallet_version = 1`,
        [IDS.walletA],
      );
      const seen = await uow.run('reconciliation', async (repos) => ({
        batch: await repos.reconciliation.walletBatch(undefined, 1),
        snapshot: await repos.reconciliation.walletSnapshot(IDS.walletA),
      }));
      expect(seen.batch).toEqual([
        {
          walletId: IDS.walletA,
          balance: '70.00',
          version: 2,
          calculated: '-30.00',
          entries: 1,
          firstVersion: 2,
          lastVersion: 2,
        },
      ]);
      expect(seen.snapshot).toMatchObject({ credits: '0.00', debits: '30.00', entries: 1 });
      expect(seen.snapshot?.chain.map((row) => row.walletVersion)).toEqual([2]);
    });
  });

  describe('insertRun', () => {
    it('writes a WALLET run and a GLOBAL run', async () => {
      await uow.run('short', (repos) => {
        repos.reconciliation.insertRun({
          id: IDS.walletRun,
          scope: 'WALLET',
          walletId: IDS.walletA,
          consistent: false,
          checkedEntries: 2,
          stored: Money.fromPersistence('70.00', 'BRL'),
          calculated: Money.fromSignedDecimal('75.00', 'BRL'),
          difference: Money.fromSignedDecimal('-5.00', 'BRL'),
          currency: 'BRL',
          firstDivergentVersion: 2,
          details: { problems: ['BALANCE_MISMATCH'] },
          startedAt: STARTED_AT,
          finishedAt: FINISHED_AT,
        });
        repos.reconciliation.insertRun({
          id: IDS.globalRun,
          scope: 'GLOBAL',
          walletId: undefined,
          consistent: true,
          checkedEntries: 3,
          stored: undefined,
          calculated: undefined,
          difference: undefined,
          currency: undefined,
          firstDivergentVersion: undefined,
          details: { walletsChecked: 3, suspiciousWallets: [] },
          startedAt: STARTED_AT,
          finishedAt: FINISHED_AT,
        });
        return Promise.resolve();
      });
      expect(await storedRuns(database)).toEqual([
        {
          id: IDS.walletRun,
          scope: 'WALLET',
          wallet_id: IDS.walletA,
          consistent: false,
          checked_entries: 2,
          stored_amount: '70.00',
          calculated_amount: '75.00',
          difference_amount: '-5.00',
          currency: 'BRL',
          first_divergent_version: 2,
          details: { problems: ['BALANCE_MISMATCH'] },
          started_at: '2026-10-24T12:00:00.000',
          finished_at: '2026-10-24T12:00:01.500',
        },
        {
          id: IDS.globalRun,
          scope: 'GLOBAL',
          wallet_id: null,
          consistent: true,
          checked_entries: 3,
          stored_amount: null,
          calculated_amount: null,
          difference_amount: null,
          currency: null,
          first_divergent_version: null,
          details: { walletsChecked: 3, suspiciousWallets: [] },
          started_at: '2026-10-24T12:00:00.000',
          finished_at: '2026-10-24T12:00:01.500',
        },
      ]);
    });
  });
});
