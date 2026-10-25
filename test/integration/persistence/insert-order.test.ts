import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import { Money } from '@domain/shared/money';
import { WagerTransaction } from '@domain/wagering/wager-transaction';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { HouseAccountPurpose } from '@domain/wallet/house-account';
import { Wallet } from '@domain/wallet/wallet';
import { loadConfig } from '@infrastructure/config/env.schema';
import { MikroOrmUnitOfWork } from '@infrastructure/persistence/mikro-orm-unit-of-work';
import { closeOrmInstances, openOrmInstances } from '@infrastructure/persistence/orm-instances';
import type { OrmInstances } from '@infrastructure/persistence/orm-instances';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';

const CURRENCY = 'BRL';
const PROVIDER = 'provider-insert-order';
const NOW = new Date('2026-10-24T12:00:00.000Z');

class MissingFixtureError extends Error {
  constructor(what: string) {
    super(`fixture is missing ${what}`);
    this.name = 'MissingFixtureError';
  }
}

interface Counts {
  readonly wallets: number;
  readonly transactions: number;
  readonly entries: number;
  readonly balance: string | null;
  readonly version: number | null;
}

const money = (amount: string): Money => Money.from({ amount, currency: CURRENCY });

const failureOf = <T>(promise: Promise<T>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );

const countsOf = async (database: TestDatabase, walletId: string): Promise<Counts | undefined> => {
  const client = new Client({ connectionString: database.superuserUrl });
  await client.connect();
  try {
    const result = await client.query<Counts>(
      `SELECT (SELECT count(*)::int FROM wallets WHERE id = $1) AS wallets,
              (SELECT count(*)::int FROM wager_transactions WHERE wallet_id = $1) AS transactions,
              (SELECT count(*)::int FROM ledger_entries e JOIN wager_transactions t ON t.id = e.transaction_id
                WHERE t.wallet_id = $1) AS entries,
              (SELECT balance::text FROM wallets WHERE id = $1) AS balance,
              (SELECT version FROM wallets WHERE id = $1) AS version`,
      [walletId],
    );
    return result.rows[0];
  } finally {
    await client.end();
  }
};

const betFor = (wallet: Wallet, amount: string): WagerTransaction =>
  WagerTransaction.create({
    id: crypto.randomUUID(),
    providerId: PROVIDER,
    externalTransactionId: `ext-${crypto.randomUUID()}`,
    idempotencyKey: crypto.randomUUID(),
    payloadHash: 'b'.repeat(64),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: money(amount),
    referenceExternalTransactionId: undefined,
    correlationId: 'correlation-1',
    now: NOW,
  });

describe('insert order within a single flush', () => {
  let database: TestDatabase;
  let opened: OrmInstances[] = [];

  const openUnitOfWork = async (): Promise<MikroOrmUnitOfWork> => {
    const config = loadConfig({ DATABASE_URL: database.appUrl }, { role: 'api' });
    const instances = await openOrmInstances(config);
    opened.push(instances);
    return new MikroOrmUnitOfWork(instances, config);
  };

  const openFundedWallet = (
    uow: MikroOrmUnitOfWork,
  ): Promise<{ wallet: Wallet; gamingId: string }> =>
    uow.run('write', async (repos) => {
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
        initialBalance: money('100.00'),
        openingTransactionId,
        fundingAccountId: funding.id,
        walletEntryId: crypto.randomUUID(),
        houseEntryId: crypto.randomUUID(),
        now: NOW,
      });
      if (opened.posting === undefined) {
        throw new MissingFixtureError('the opening posting');
      }
      repos.ledger.insertPosting(opened.posting);
      repos.transactions.insert(
        WagerTransaction.opening({
          id: openingTransactionId,
          walletId: opened.wallet.id,
          playerId: opened.wallet.playerId,
          money: money('100.00'),
          payloadHash: 'a'.repeat(64),
          correlationId: 'correlation-opening',
          now: NOW,
        }),
      );
      repos.wallets.insert(opened.wallet);
      await repos.flush();
      await repos.wallets.assertPersistedVersion(opened.wallet);
      return { wallet: opened.wallet, gamingId: gaming.id };
    });

  beforeEach(async () => {
    database = await createTestDatabase();
  });

  afterEach(async () => {
    await Promise.all(opened.map(closeOrmInstances));
    opened = [];
  });

  it('commits a new funded wallet with its opening transaction and posting from one flush', async () => {
    const uow = await openUnitOfWork();
    const { wallet } = await openFundedWallet(uow);
    expect(await countsOf(database, wallet.id)).toEqual({
      wallets: 1,
      transactions: 1,
      entries: 2,
      balance: '100.00',
      version: 1,
    });
  });

  it('commits a movement whose transaction, posting and wallet update share one flush', async () => {
    const uow = await openUnitOfWork();
    const { wallet, gamingId } = await openFundedWallet(uow);
    await uow.run('write', async (repos) => {
      const locked = await repos.wallets.lockById(wallet.id);
      if (locked === undefined) {
        throw new MissingFixtureError('the wallet');
      }
      const bet = betFor(locked.wallet, '30.00');
      const posting = locked.wallet.debit({
        transactionId: bet.id,
        money: bet.money,
        houseAccountId: gamingId,
        walletEntryId: crypto.randomUUID(),
        houseEntryId: crypto.randomUUID(),
        now: NOW,
      });
      bet.markProcessed({
        referenceTransactionId: undefined,
        balanceSnapshot: locked.wallet.balance,
        at: NOW,
      });
      repos.wallets.update(locked.wallet);
      repos.ledger.insertPosting(posting);
      repos.transactions.insert(bet);
      await repos.flush();
      await repos.wallets.assertPersistedVersion(locked.wallet);
    });
    expect(await countsOf(database, wallet.id)).toEqual({
      wallets: 1,
      transactions: 2,
      entries: 4,
      balance: '70.00',
      version: 2,
    });
  });

  it('defers the ledger checks to commit, so a posting without its wallet update rolls back', async () => {
    const uow = await openUnitOfWork();
    const { wallet, gamingId } = await openFundedWallet(uow);
    const flushed: { passed: boolean } = { passed: false };
    const failure = await failureOf(
      uow.run('write', async (repos) => {
        const locked = await repos.wallets.lockById(wallet.id);
        if (locked === undefined) {
          throw new MissingFixtureError('the wallet');
        }
        const bet = betFor(locked.wallet, '30.00');
        const posting = locked.wallet.debit({
          transactionId: bet.id,
          money: bet.money,
          houseAccountId: gamingId,
          walletEntryId: crypto.randomUUID(),
          houseEntryId: crypto.randomUUID(),
          now: NOW,
        });
        bet.markProcessed({
          referenceTransactionId: undefined,
          balanceSnapshot: locked.wallet.balance,
          at: NOW,
        });
        repos.ledger.insertPosting(posting);
        repos.transactions.insert(bet);
        await repos.flush();
        flushed.passed = true;
      }),
    );
    expect(flushed.passed).toBe(true);
    expect(failure).toBeInstanceOf(TechnicalError);
    expect(Reflect.get(Object(failure), 'errorClass')).toBe(ErrorClass.Deterministic);
    expect(await countsOf(database, wallet.id)).toEqual({
      wallets: 1,
      transactions: 1,
      entries: 2,
      balance: '100.00',
      version: 1,
    });
  });
});
