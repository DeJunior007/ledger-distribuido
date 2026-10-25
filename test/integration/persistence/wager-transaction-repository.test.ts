import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import type { Repositories } from '@application/ports/unit-of-work.port';
import { FailureCode } from '@domain/shared/failure-code';
import { Money } from '@domain/shared/money';
import { WagerTransaction } from '@domain/wagering/wager-transaction';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '@domain/wagering/wager-transaction-status';
import { HouseAccountPurpose } from '@domain/wallet/house-account';
import { LedgerDirection } from '@domain/wallet/ledger-direction';
import { Wallet } from '@domain/wallet/wallet';
import { loadConfig } from '@infrastructure/config/env.schema';
import { MikroOrmUnitOfWork } from '@infrastructure/persistence/mikro-orm-unit-of-work';
import { closeOrmInstances, openOrmInstances } from '@infrastructure/persistence/orm-instances';
import type { OrmInstances } from '@infrastructure/persistence/orm-instances';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';

const CURRENCY = 'BRL';
const PROVIDER = 'provider-transaction-repository';
const NOW = new Date('2026-10-24T12:00:00.000Z');
const LATER = new Date('2026-10-24T12:05:00.000Z');
const MAX_BALANCE = '999999999999999999.99';

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
}

interface Request {
  readonly kind: WagerTransactionKind;
  readonly amount: string;
  readonly roundId?: string;
  readonly reference?: WagerTransaction;
}

interface StoredTransaction {
  readonly status: string;
  readonly failure_code: string | null;
  readonly reference_transaction_id: string | null;
  readonly balance_snapshot_amount: string | null;
}

const money = (amount: string): Money => Money.from({ amount, currency: CURRENCY });

const failureOf = <T>(promise: Promise<T>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );

const storedTransaction = async (
  database: TestDatabase,
  id: string,
): Promise<StoredTransaction | undefined> => {
  const client = new Client({ connectionString: database.superuserUrl });
  await client.connect();
  try {
    const result = await client.query<StoredTransaction>(
      `SELECT status, failure_code, reference_transaction_id, balance_snapshot_amount::text AS balance_snapshot_amount
       FROM wager_transactions WHERE id = $1`,
      [id],
    );
    return result.rows[0];
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
  return { walletId: opened.wallet.id, playerId: opened.wallet.playerId, gamingId: gaming.id };
};

const requestFor = (seed: Seed, request: Request): WagerTransaction =>
  WagerTransaction.create({
    id: crypto.randomUUID(),
    providerId: PROVIDER,
    externalTransactionId: `ext-${crypto.randomUUID()}`,
    idempotencyKey: crypto.randomUUID(),
    payloadHash: 'b'.repeat(64),
    walletId: seed.walletId,
    playerId: seed.playerId,
    roundId: request.roundId ?? 'round-1',
    gameId: 'game-1',
    kind: request.kind,
    money: money(request.amount),
    referenceExternalTransactionId: request.reference?.externalTransactionId,
    correlationId: 'correlation-1',
    now: NOW,
  });

const processMovement = async (
  repos: Repositories,
  seed: Seed,
  request: Request,
): Promise<WagerTransaction> => {
  const transaction = requestFor(seed, request);
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
    now: NOW,
  };
  const posting =
    transaction.ledgerDirectionFor(request.reference) === LedgerDirection.Debit
      ? locked.wallet.debit(movement)
      : locked.wallet.credit(movement);
  transaction.markProcessed({
    referenceTransactionId: request.reference?.id,
    balanceSnapshot: locked.wallet.balance,
    at: NOW,
  });
  repos.transactions.insert(transaction);
  repos.ledger.insertPosting(posting);
  repos.wallets.update(locked.wallet);
  await repos.flush();
  return transaction;
};

const pendingReference = async (
  repos: Repositories,
  seed: Seed,
  request: Request,
  snapshot = '100.00',
): Promise<WagerTransaction> => {
  const transaction = requestFor(seed, request);
  transaction.markPendingReference({ balanceSnapshot: money(snapshot), at: NOW });
  repos.transactions.insert(transaction);
  await repos.flush();
  return transaction;
};

const rejected = async (
  repos: Repositories,
  seed: Seed,
  request: Request,
): Promise<WagerTransaction> => {
  const transaction = requestFor(seed, request);
  transaction.reject({
    failureCode: FailureCode.InsufficientFundsForReversal,
    referenceTransactionId: request.reference?.id,
    balanceSnapshot: money('100.00'),
    at: NOW,
  });
  repos.transactions.insert(transaction);
  await repos.flush();
  return transaction;
};

describe('MikroOrmWagerTransactionRepository', () => {
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

  describe('insert and finders', () => {
    it('inserts a transaction and finds it by id and by provider and external id', async () => {
      const uow = await openUnitOfWork();
      const bet = await uow.run('write', async (repos) => {
        const seed = await openWallet(repos, '100.00');
        return processMovement(repos, seed, { kind: WagerTransactionKind.Bet, amount: '30.00' });
      });
      const found = await uow.read(async (repos) => ({
        byId: await repos.transactions.findById(bet.id),
        byExternal: await repos.transactions.findByProviderAndExternalId(
          PROVIDER,
          bet.externalTransactionId,
        ),
        otherProvider: await repos.transactions.findByProviderAndExternalId(
          'another-provider',
          bet.externalTransactionId,
        ),
        unknown: await repos.transactions.findById(crypto.randomUUID()),
      }));
      expect(found.byId?.toState()).toEqual(bet.toState());
      expect(found.byExternal?.id).toBe(bet.id);
      expect(found.otherProvider).toBeUndefined();
      expect(found.unknown).toBeUndefined();
    });

    it('keeps the reference transaction id of a processed reversal', async () => {
      const uow = await openUnitOfWork();
      const { bet, refund } = await uow.run('write', async (repos) => {
        const seed = await openWallet(repos, '100.00');
        const placed = await processMovement(repos, seed, {
          kind: WagerTransactionKind.Bet,
          amount: '30.00',
        });
        const refunded = await processMovement(repos, seed, {
          kind: WagerTransactionKind.Refund,
          amount: '30.00',
          reference: placed,
        });
        return { bet: placed, refund: refunded };
      });
      const found = await uow.read((repos) => repos.transactions.findById(refund.id));
      expect(found?.referenceTransactionId).toBe(bet.id);
      expect(found?.referenceExternalTransactionId).toBe(bet.externalTransactionId);
      expect(found?.balanceSnapshot?.toJSON()).toEqual({ amount: '100.00', currency: CURRENCY });
    });
  });

  describe('refresh', () => {
    it('sees a commit from another connection only when asked to refresh', async () => {
      const uow = await openUnitOfWork();
      const win = await uow.run('write', async (repos) => {
        const seed = await openWallet(repos, '100.00');
        return pendingReference(repos, seed, {
          kind: WagerTransactionKind.Win,
          amount: '10.00',
          reference: requestFor(seed, { kind: WagerTransactionKind.Bet, amount: '10.00' }),
        });
      });
      const observed = await uow.run('write', async (repos) => {
        const beforeById = await repos.transactions.findById(win.id);
        const beforeByExternal = await repos.transactions.findByProviderAndExternalId(
          PROVIDER,
          win.externalTransactionId,
        );
        await uow.run('write', async (other) => {
          const current = await other.transactions.findById(win.id, { refresh: true });
          if (current === undefined) {
            throw new MissingFixtureError('the pending transaction');
          }
          current.fail({ balanceSnapshot: money('100.00'), at: LATER });
          other.transactions.update(current);
        });
        return {
          beforeById: beforeById?.status,
          beforeByExternal: beforeByExternal?.status,
          cachedById: (await repos.transactions.findById(win.id))?.status,
          refreshedById: (await repos.transactions.findById(win.id, { refresh: true }))?.status,
          refreshedByExternal: (
            await repos.transactions.findByProviderAndExternalId(
              PROVIDER,
              win.externalTransactionId,
              { refresh: true },
            )
          )?.status,
        };
      });
      expect(observed).toEqual({
        beforeById: WagerTransactionStatus.PendingReference,
        beforeByExternal: WagerTransactionStatus.PendingReference,
        cachedById: WagerTransactionStatus.PendingReference,
        refreshedById: WagerTransactionStatus.Failed,
        refreshedByExternal: WagerTransactionStatus.Failed,
      });
    });
  });

  describe('update', () => {
    it('resolves a pending reference by writing only the mutable columns', async () => {
      const uow = await openUnitOfWork();
      const { bet, refund } = await uow.run('write', async (repos) => {
        const seed = await openWallet(repos, '100.00');
        const placed = await processMovement(repos, seed, {
          kind: WagerTransactionKind.Bet,
          amount: '10.00',
        });
        const waiting = await pendingReference(repos, seed, {
          kind: WagerTransactionKind.Refund,
          amount: '10.00',
          reference: placed,
        });
        return { bet: placed, refund: waiting };
      });
      await uow.run('write', async (repos) => {
        const current = await repos.transactions.findById(refund.id, { refresh: true });
        if (current === undefined) {
          throw new MissingFixtureError('the pending transaction');
        }
        current.reject({
          failureCode: FailureCode.InsufficientFundsForReversal,
          referenceTransactionId: bet.id,
          balanceSnapshot: money('90.00'),
          at: LATER,
        });
        repos.transactions.update(current);
      });
      expect(await storedTransaction(database, refund.id)).toEqual({
        status: WagerTransactionStatus.Rejected,
        failure_code: FailureCode.InsufficientFundsForReversal,
        reference_transaction_id: bet.id,
        balance_snapshot_amount: '90.00',
      });
    });

    it('rewrites a snapshot at the numeric limit that moved by a single cent', async () => {
      const uow = await openUnitOfWork();
      const refund = await uow.run('write', async (repos) => {
        const seed = await openWallet(repos, MAX_BALANCE);
        return pendingReference(
          repos,
          seed,
          {
            kind: WagerTransactionKind.Refund,
            amount: '0.01',
            reference: requestFor(seed, { kind: WagerTransactionKind.Bet, amount: '0.01' }),
          },
          MAX_BALANCE,
        );
      });
      await uow.run('write', async (repos) => {
        const current = await repos.transactions.findById(refund.id, { refresh: true });
        if (current === undefined) {
          throw new MissingFixtureError('the pending transaction');
        }
        current.fail({ balanceSnapshot: money('999999999999999999.98'), at: LATER });
        repos.transactions.update(current);
      });
      expect(await storedTransaction(database, refund.id)).toEqual({
        status: WagerTransactionStatus.Failed,
        failure_code: FailureCode.ProcessingFailed,
        reference_transaction_id: null,
        balance_snapshot_amount: '999999999999999999.98',
      });
    });

    it('refuses to update a transaction that was not loaded in the unit of work', async () => {
      const uow = await openUnitOfWork();
      const win = await uow.run('write', async (repos) => {
        const seed = await openWallet(repos, '0.00');
        return pendingReference(repos, seed, {
          kind: WagerTransactionKind.Win,
          amount: '10.00',
          reference: requestFor(seed, { kind: WagerTransactionKind.Bet, amount: '10.00' }),
        });
      });
      const failure = await failureOf(
        uow.run('write', (repos) => {
          const detached = WagerTransaction.rehydrate(win.toState());
          detached.fail({ balanceSnapshot: undefined, at: LATER });
          repos.transactions.update(detached);
          return Promise.resolve();
        }),
      );
      expect(failure).toBeInstanceOf(TechnicalError);
      expect(Reflect.get(Object(failure), 'errorClass')).toBe(ErrorClass.Deterministic);
      expect((await storedTransaction(database, win.id))?.status).toBe(
        WagerTransactionStatus.PendingReference,
      );
    });
  });

  describe('isReversed', () => {
    it('is true only when a processed refund or rollback references the transaction', async () => {
      const uow = await openUnitOfWork();
      const result = await uow.run('write', async (repos) => {
        const seed = await openWallet(repos, '100.00');
        const untouched = await processMovement(repos, seed, {
          kind: WagerTransactionKind.Bet,
          amount: '10.00',
        });
        const refused = await processMovement(repos, seed, {
          kind: WagerTransactionKind.Bet,
          amount: '10.00',
        });
        await rejected(repos, seed, {
          kind: WagerTransactionKind.Refund,
          amount: '10.00',
          reference: refused,
        });
        const won = await processMovement(repos, seed, {
          kind: WagerTransactionKind.Bet,
          amount: '10.00',
        });
        await processMovement(repos, seed, {
          kind: WagerTransactionKind.Win,
          amount: '10.00',
          reference: won,
        });
        const refunded = await processMovement(repos, seed, {
          kind: WagerTransactionKind.Bet,
          amount: '10.00',
        });
        await processMovement(repos, seed, {
          kind: WagerTransactionKind.Refund,
          amount: '10.00',
          reference: refunded,
        });
        const rolledBack = await processMovement(repos, seed, {
          kind: WagerTransactionKind.Bet,
          amount: '10.00',
        });
        await processMovement(repos, seed, {
          kind: WagerTransactionKind.Rollback,
          amount: '10.00',
          reference: rolledBack,
        });
        return {
          untouched: await repos.transactions.isReversed(untouched.id),
          refused: await repos.transactions.isReversed(refused.id),
          won: await repos.transactions.isReversed(won.id),
          refunded: await repos.transactions.isReversed(refunded.id),
          rolledBack: await repos.transactions.isReversed(rolledBack.id),
          unknown: await repos.transactions.isReversed(crypto.randomUUID()),
        };
      });
      expect(result).toEqual({
        untouched: false,
        refused: false,
        won: false,
        refunded: true,
        rolledBack: true,
        unknown: false,
      });
    });
  });

  describe('hasProcessedWinInRound', () => {
    it('is true only for a processed win of the same wallet and round', async () => {
      const uow = await openUnitOfWork();
      const result = await uow.run('write', async (repos) => {
        const seed = await openWallet(repos, '100.00');
        const other = await openWallet(repos, '100.00');
        await processMovement(repos, seed, {
          kind: WagerTransactionKind.Win,
          amount: '10.00',
          roundId: 'round-won',
        });
        await processMovement(repos, seed, {
          kind: WagerTransactionKind.Bet,
          amount: '10.00',
          roundId: 'round-bet',
        });
        await pendingReference(repos, seed, {
          kind: WagerTransactionKind.Win,
          amount: '10.00',
          roundId: 'round-pending',
          reference: requestFor(seed, { kind: WagerTransactionKind.Bet, amount: '10.00' }),
        });
        await rejected(repos, seed, {
          kind: WagerTransactionKind.Win,
          amount: '10.00',
          roundId: 'round-rejected',
        });
        return {
          won: await repos.transactions.hasProcessedWinInRound(seed.walletId, 'round-won'),
          otherWallet: await repos.transactions.hasProcessedWinInRound(other.walletId, 'round-won'),
          betOnly: await repos.transactions.hasProcessedWinInRound(seed.walletId, 'round-bet'),
          pending: await repos.transactions.hasProcessedWinInRound(seed.walletId, 'round-pending'),
          rejected: await repos.transactions.hasProcessedWinInRound(
            seed.walletId,
            'round-rejected',
          ),
          unknownRound: await repos.transactions.hasProcessedWinInRound(seed.walletId, "round-'?"),
        };
      });
      expect(result).toEqual({
        won: true,
        otherWallet: false,
        betOnly: false,
        pending: false,
        rejected: false,
        unknownRound: false,
      });
    });
  });
});
