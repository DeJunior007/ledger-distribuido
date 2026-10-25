import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import type { Repositories } from '@application/ports/unit-of-work.port';
import { Money } from '@domain/shared/money';
import { WagerTransaction } from '@domain/wagering/wager-transaction';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { HouseAccountPurpose } from '@domain/wallet/house-account';
import { LedgerDirection } from '@domain/wallet/ledger-direction';
import { Wallet } from '@domain/wallet/wallet';
import type { WalletLedgerEntry } from '@domain/wallet/wallet-ledger-entry';
import { loadConfig } from '@infrastructure/config/env.schema';
import { MikroOrmUnitOfWork } from '@infrastructure/persistence/mikro-orm-unit-of-work';
import { closeOrmInstances, openOrmInstances } from '@infrastructure/persistence/orm-instances';
import type { OrmInstances } from '@infrastructure/persistence/orm-instances';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';

const CURRENCY = 'BRL';
const PROVIDER = 'provider-ledger-repository';
const NOW = new Date('2026-10-24T12:00:00.000Z');

class MissingFixtureError extends Error {
  constructor(what: string) {
    super(`fixture is missing ${what}`);
    this.name = 'MissingFixtureError';
  }
}

interface Seed {
  readonly walletId: string;
  readonly playerId: string;
  readonly gamingId: string;
  readonly openingEntry: WalletLedgerEntry | undefined;
}

interface StoredEntry {
  readonly account_kind: string;
  readonly wallet_id: string | null;
  readonly house_account_id: string | null;
  readonly direction: string;
  readonly amount: string;
  readonly wallet_version: number | null;
}

const money = (amount: string): Money => Money.from({ amount, currency: CURRENCY });

const storedEntries = async (
  database: TestDatabase,
  transactionId: string,
): Promise<StoredEntry[]> => {
  const client = new Client({ connectionString: database.superuserUrl });
  await client.connect();
  try {
    const result = await client.query<StoredEntry>(
      `SELECT account_kind, wallet_id, house_account_id, direction, amount::text AS amount, wallet_version
       FROM ledger_entries WHERE transaction_id = $1 ORDER BY account_kind DESC`,
      [transactionId],
    );
    return result.rows;
  } finally {
    await client.end();
  }
};

const openWallet = async (repos: Repositories, initialBalance: string): Promise<Seed> => {
  const gaming = await repos.houseAccounts.ensure(
    CURRENCY,
    HouseAccountPurpose.Gaming,
    crypto.randomUUID(),
    NOW,
  );
  const funding = await repos.houseAccounts.ensure(
    CURRENCY,
    HouseAccountPurpose.Funding,
    crypto.randomUUID(),
    NOW,
  );
  const openingTransactionId = crypto.randomUUID();
  const opened = Wallet.open({
    id: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    initialBalance: money(initialBalance),
    openingTransactionId,
    fundingAccountId: funding.id,
    walletEntryId: crypto.randomUUID(),
    houseEntryId: crypto.randomUUID(),
    now: NOW,
  });
  repos.wallets.insert(opened.wallet);
  if (opened.posting !== undefined) {
    repos.transactions.insert(
      WagerTransaction.opening({
        id: openingTransactionId,
        walletId: opened.wallet.id,
        playerId: opened.wallet.playerId,
        money: money(initialBalance),
        payloadHash: 'a'.repeat(64),
        correlationId: 'correlation-opening',
        now: NOW,
      }),
    );
    repos.ledger.insertPosting(opened.posting);
  }
  await repos.flush();
  return {
    walletId: opened.wallet.id,
    playerId: opened.wallet.playerId,
    gamingId: gaming.id,
    openingEntry: opened.posting?.walletEntry,
  };
};

const move = async (
  repos: Repositories,
  seed: Seed,
  kind: WagerTransactionKind,
  amount: string,
  at: Date,
): Promise<WalletLedgerEntry> => {
  const transaction = WagerTransaction.create({
    id: crypto.randomUUID(),
    providerId: PROVIDER,
    externalTransactionId: `ext-${crypto.randomUUID()}`,
    idempotencyKey: crypto.randomUUID(),
    payloadHash: 'b'.repeat(64),
    walletId: seed.walletId,
    playerId: seed.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: money(amount),
    referenceExternalTransactionId: undefined,
    correlationId: 'correlation-1',
    now: at,
  });
  const locked = await repos.wallets.lockById(seed.walletId);
  if (locked === undefined) {
    throw new MissingFixtureError('the wallet');
  }
  const movement = {
    transactionId: transaction.id,
    money: transaction.money,
    houseAccountId: seed.gamingId,
    walletEntryId: crypto.randomUUID(),
    houseEntryId: crypto.randomUUID(),
    now: at,
  };
  const posting =
    transaction.ledgerDirectionFor(undefined) === LedgerDirection.Debit
      ? locked.wallet.debit(movement)
      : locked.wallet.credit(movement);
  transaction.markProcessed({
    referenceTransactionId: undefined,
    balanceSnapshot: locked.wallet.balance,
    at,
  });
  repos.transactions.insert(transaction);
  repos.ledger.insertPosting(posting);
  repos.wallets.update(locked.wallet);
  await repos.flush();
  return posting.walletEntry;
};

const versionsOf = (entries: readonly WalletLedgerEntry[]): number[] =>
  entries.map((entry) => entry.walletVersion);

describe('MikroOrmLedgerRepository', () => {
  let database: TestDatabase;
  let opened: OrmInstances[] = [];

  const openUnitOfWork = async (): Promise<MikroOrmUnitOfWork> => {
    const config = loadConfig({ DATABASE_URL: database.appUrl }, { role: 'api' });
    const instances = await openOrmInstances(config);
    opened.push(instances);
    return new MikroOrmUnitOfWork(instances, config);
  };

  beforeEach(async () => {
    database = await createTestDatabase();
  });

  afterEach(async () => {
    await Promise.all(opened.map(closeOrmInstances));
    opened = [];
  });

  describe('insertPosting', () => {
    it('writes the wallet leg and the house leg of a posting', async () => {
      const uow = await openUnitOfWork();
      const { seed, entry } = await uow.run('write', async (repos) => {
        const created = await openWallet(repos, '100.00');
        const bet = await move(repos, created, WagerTransactionKind.Bet, '30.00', NOW);
        return { seed: created, entry: bet };
      });
      expect(await storedEntries(database, entry.transactionId)).toEqual([
        {
          account_kind: 'WALLET',
          wallet_id: seed.walletId,
          house_account_id: null,
          direction: LedgerDirection.Debit,
          amount: '30.00',
          wallet_version: 2,
        },
        {
          account_kind: 'HOUSE',
          wallet_id: null,
          house_account_id: seed.gamingId,
          direction: LedgerDirection.Credit,
          amount: '30.00',
          wallet_version: null,
        },
      ]);
    });
  });

  describe('listWalletEntries', () => {
    it('pages the wallet entries by descending wallet version', async () => {
      const uow = await openUnitOfWork();
      const { seed, entries } = await uow.run('write', async (repos) => {
        const created = await openWallet(repos, '100.00');
        const other = await openWallet(repos, '50.00');
        const moved = [
          await move(repos, created, WagerTransactionKind.Bet, '10.00', NOW),
          await move(repos, created, WagerTransactionKind.Win, '25.50', NOW),
          await move(repos, other, WagerTransactionKind.Bet, '5.00', NOW),
          await move(repos, created, WagerTransactionKind.Bet, '40.00', NOW),
          await move(repos, created, WagerTransactionKind.Win, '0.01', NOW),
        ];
        return { seed: created, entries: moved };
      });
      const pages = await uow.read(async (repos) => ({
        first: await repos.ledger.listWalletEntries(seed.walletId, {
          beforeVersion: undefined,
          limit: 2,
        }),
        second: await repos.ledger.listWalletEntries(seed.walletId, {
          beforeVersion: 4,
          limit: 2,
        }),
        last: await repos.ledger.listWalletEntries(seed.walletId, {
          beforeVersion: 2,
          limit: 10,
        }),
        beyond: await repos.ledger.listWalletEntries(seed.walletId, {
          beforeVersion: 1,
          limit: 10,
        }),
        unknown: await repos.ledger.listWalletEntries(crypto.randomUUID(), {
          beforeVersion: undefined,
          limit: 10,
        }),
      }));
      expect(versionsOf(pages.first)).toEqual([5, 4]);
      expect(versionsOf(pages.second)).toEqual([3, 2]);
      expect(versionsOf(pages.last)).toEqual([1]);
      expect(pages.beyond).toEqual([]);
      expect(pages.unknown).toEqual([]);
      const ownEntries = entries.filter((entry) => entry.walletId === seed.walletId);
      expect([...pages.first, ...pages.second]).toEqual(ownEntries.reverse());
      expect(pages.last).toEqual(seed.openingEntry === undefined ? [] : [seed.openingEntry]);
    });

    it('returns the balances and the creation time of each entry', async () => {
      const uow = await openUnitOfWork();
      const at = new Date('2026-10-24T09:30:15.123Z');
      const entry = await uow.run('write', async (repos) => {
        const seed = await openWallet(repos, '999999999999999999.99');
        return move(repos, seed, WagerTransactionKind.Bet, '999999999999999999.98', at);
      });
      const [listed] = await uow.read((repos) =>
        repos.ledger.listWalletEntries(entry.walletId, { beforeVersion: undefined, limit: 1 }),
      );
      expect(listed?.balanceBefore.toJSON()).toEqual({
        amount: '999999999999999999.99',
        currency: CURRENCY,
      });
      expect(listed?.balanceAfter.toJSON()).toEqual({ amount: '0.01', currency: CURRENCY });
      expect(listed?.createdAt.toISOString()).toBe(at.toISOString());
      expect(listed).toEqual(entry);
    });
  });
});
