import { describe, expect, it } from 'bun:test';
import type { CreateWalletCommand } from '@application/commands/create-wallet.command';
import { WalletAlreadyExistsError } from '@application/errors/wallet-already-exists.error';
import { computeOpeningPayloadHash } from '@application/services/payload-hash';
import { CreateWalletUseCase } from '@application/use-cases/create-wallet.use-case';
import { InvalidMoneyError } from '@domain/shared/errors/invalid-money.error';
import { Money } from '@domain/shared/money';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '@domain/wagering/wager-transaction-status';
import { HouseAccountPurpose } from '@domain/wallet/house-account';
import { LedgerDirection } from '@domain/wallet/ledger-direction';
import { Wallet } from '@domain/wallet/wallet';
import { Sha256Hasher } from '@infrastructure/system/sha256-hasher';
import { InMemoryUnitOfWork } from '@test/support/fakes/in-memory-unit-of-work.fake';
import { FakeLogger } from '@test/support/fakes/logger.fake';
import { FakeMetrics } from '@test/support/fakes/metrics.fake';
import { FakeTracer } from '@test/support/fakes/tracer.fake';
import { FixedClock } from '@test/support/fixed-clock';
import { SequentialIds } from '@test/support/sequential-ids';

const now = new Date('2026-03-01T12:00:00.000Z');

const sequentialId = (position: number): string =>
  `00000000-0000-7000-8000-${position.toString(16).padStart(12, '0')}`;

interface Harness {
  readonly uow: InMemoryUnitOfWork;
  readonly tracer: FakeTracer;
  readonly hasher: Sha256Hasher;
  readonly enriched: { walletId?: string }[];
  readonly useCase: CreateWalletUseCase;
}

const createHarness = (): Harness => {
  const clock = new FixedClock(now);
  const uow = new InMemoryUnitOfWork(clock);
  const tracer = new FakeTracer();
  const hasher = new Sha256Hasher();
  const enriched: { walletId?: string }[] = [];
  const useCase = new CreateWalletUseCase({
    uow,
    clock,
    ids: new SequentialIds(),
    hasher,
    logger: new FakeLogger(),
    metrics: new FakeMetrics(),
    tracer,
    enrich: (fields) => {
      enriched.push({ ...fields });
    },
  });
  return { uow, tracer, hasher, enriched, useCase };
};

const command = (amount: string, playerId = 'player-1', currency = 'BRL'): CreateWalletCommand => ({
  playerId,
  initialBalance: { amount, currency },
  correlationId: 'correlation-1',
  causationId: 'causation-1',
});

const captureError = async (action: () => Promise<unknown>): Promise<unknown> => {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('CreateWalletUseCase', () => {
  it('creates only the wallet when the initial balance is zero', async () => {
    const { uow, useCase } = createHarness();

    const view = await useCase.execute(command('0.00'));

    expect(view).toEqual({
      id: view.id,
      playerId: 'player-1',
      balance: { amount: '0.00', currency: 'BRL' },
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    const wallets = uow.database.wallets.rows();
    expect(wallets).toHaveLength(1);
    expect(wallets[0]?.id).toBe(view.id);
    expect(wallets[0]?.balance.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(uow.database.transactions.rows()).toEqual([]);
    expect(uow.database.walletEntries.rows()).toEqual([]);
    expect(uow.database.houseEntries.rows()).toEqual([]);
    expect(uow.database.outbox.rows()).toEqual([]);
  });

  it('records the opening transaction and its posting when the initial balance is positive', async () => {
    const { uow, hasher, useCase } = createHarness();

    const view = await useCase.execute(command('150.25'));

    expect(view.balance).toEqual({ amount: '150.25', currency: 'BRL' });
    expect(view.version).toBe(1);
    const funding = uow.database.houseAccounts
      .rows()
      .find((account) => account.purpose === HouseAccountPurpose.Funding);
    const transactions = uow.database.transactions.rows();
    expect(transactions).toHaveLength(1);
    const opening = transactions[0];
    expect(opening?.kind).toBe(WagerTransactionKind.Opening);
    expect(opening?.status).toBe(WagerTransactionStatus.Processed);
    expect(opening?.walletId).toBe(view.id);
    expect(opening?.playerId).toBe('player-1');
    expect(opening?.correlationId).toBe('correlation-1');
    expect(opening?.money.toJSON()).toEqual({ amount: '150.25', currency: 'BRL' });
    expect(opening?.payloadHash).toBe(
      computeOpeningPayloadHash(
        { walletId: view.id, money: { amount: '150.25', currency: 'BRL' } },
        hasher,
      ),
    );

    const walletEntries = uow.database.walletEntries.rows();
    expect(walletEntries).toHaveLength(1);
    expect(walletEntries[0]?.walletId).toBe(view.id);
    expect(walletEntries[0]?.transactionId).toBe(opening?.id ?? '');
    expect(walletEntries[0]?.direction).toBe(LedgerDirection.Credit);
    expect(walletEntries[0]?.balanceBefore.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(walletEntries[0]?.balanceAfter.toJSON()).toEqual({
      amount: '150.25',
      currency: 'BRL',
    });
    expect(walletEntries[0]?.walletVersion).toBe(1);

    const houseEntries = uow.database.houseEntries.rows();
    expect(houseEntries).toHaveLength(1);
    expect(houseEntries[0]?.houseAccountId).toBe(funding?.id ?? '');
    expect(houseEntries[0]?.transactionId).toBe(opening?.id ?? '');
    expect(houseEntries[0]?.direction).toBe(LedgerDirection.Debit);
    expect(houseEntries[0]?.money.toJSON()).toEqual({ amount: '150.25', currency: 'BRL' });
  });

  it('enqueues the processed and balance changed events of the opening', async () => {
    const { uow, useCase } = createHarness();

    const view = await useCase.execute(command('80.00'));

    const opening = uow.database.transactions.rows()[0];
    const events = uow.database.outbox.rows();
    expect(events.map((event) => event.eventType)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(new Set(events.map((event) => event.id)).size).toBe(2);
    for (const event of events) {
      expect(event.aggregateId).toBe(view.id);
      expect(event.occurredAt).toEqual(now);
      expect(event.payload).toMatchObject({
        correlationId: 'correlation-1',
        causationId: 'causation-1',
        version: 1,
      });
    }
    expect(events[0]?.payload).toMatchObject({
      eventType: 'WagerTransactionProcessed',
      data: {
        transactionId: opening?.id ?? '',
        walletId: view.id,
        kind: WagerTransactionKind.Opening,
        money: { amount: '80.00', currency: 'BRL' },
        balance: { amount: '80.00', currency: 'BRL' },
        walletVersion: 1,
        processedAt: now.toISOString(),
      },
    });
    expect(events[1]?.payload).toMatchObject({
      eventType: 'WalletBalanceChanged',
      data: {
        walletId: view.id,
        transactionId: opening?.id ?? '',
        direction: LedgerDirection.Credit,
        money: { amount: '80.00', currency: 'BRL' },
        balanceBefore: { amount: '0.00', currency: 'BRL' },
        balanceAfter: { amount: '80.00', currency: 'BRL' },
        walletVersion: 1,
      },
    });
  });

  it('ensures the gaming house account before the funding one', async () => {
    const { uow, useCase } = createHarness();

    await useCase.execute(command('0.00'));

    const accounts = uow.database.houseAccounts.rows();
    expect(accounts).toHaveLength(2);
    const byPurpose = new Map(accounts.map((account) => [account.purpose, account]));
    expect(byPurpose.get(HouseAccountPurpose.Gaming)?.id).toBe(sequentialId(1));
    expect(byPurpose.get(HouseAccountPurpose.Funding)?.id).toBe(sequentialId(2));
  });

  it('reuses the existing house accounts of the currency', async () => {
    const { uow, useCase } = createHarness();

    await useCase.execute(command('10.00', 'player-1'));
    await useCase.execute(command('20.00', 'player-2'));
    await useCase.execute(command('5.00', 'player-3', 'USD'));

    const accounts = uow.database.houseAccounts.rows();
    expect(accounts).toHaveLength(4);
    const brlFunding = accounts.find(
      (account) => account.currency === 'BRL' && account.purpose === HouseAccountPurpose.Funding,
    );
    const brlHouseEntries = uow.database.houseEntries
      .rows()
      .filter((entry) => entry.money.currency === 'BRL');
    expect(brlHouseEntries).toHaveLength(2);
    expect(brlHouseEntries.every((entry) => entry.houseAccountId === brlFunding?.id)).toBe(true);
  });

  it('turns a duplicate wallet for the same player and currency into a conflict', async () => {
    const { uow, useCase } = createHarness();
    const first = await useCase.execute(command('10.00'));

    const error = await captureError(() => useCase.execute(command('30.00')));

    expect(error).toBeInstanceOf(WalletAlreadyExistsError);
    expect(error instanceof WalletAlreadyExistsError ? error.walletId : undefined).toBe(first.id);
    expect(uow.database.wallets.rows()).toHaveLength(1);
    expect(uow.database.transactions.rows()).toHaveLength(1);
    expect(uow.database.outbox.rows()).toHaveLength(2);
  });

  it('answers a concurrent creation that wins the race with the existing wallet id', async () => {
    const { uow, enriched, useCase } = createHarness();
    const rival = Wallet.open({
      id: 'rival-wallet',
      playerId: 'player-1',
      initialBalance: Money.zero('BRL'),
      openingTransactionId: 'rival-opening',
      fundingAccountId: 'rival-funding',
      walletEntryId: 'rival-wallet-entry',
      houseEntryId: 'rival-house-entry',
      now,
    }).wallet;
    uow.interceptNextCommit(async () => {
      await uow.run('write', (repos) => {
        repos.wallets.insert(rival);
        return Promise.resolve();
      });
    });

    const error = await captureError(() => useCase.execute(command('45.00')));

    expect(error).toBeInstanceOf(WalletAlreadyExistsError);
    expect(error instanceof WalletAlreadyExistsError ? error.walletId : undefined).toBe(
      'rival-wallet',
    );
    expect(uow.database.wallets.rows().map((wallet) => wallet.id)).toEqual(['rival-wallet']);
    expect(uow.database.transactions.rows()).toEqual([]);
    expect(uow.database.walletEntries.rows()).toEqual([]);
    expect(uow.database.outbox.rows()).toEqual([]);
    expect(enriched).toEqual([{ walletId: 'rival-wallet' }]);
  });

  it('lets the same player open wallets in different currencies', async () => {
    const { uow, useCase } = createHarness();

    const brlWallet = await useCase.execute(command('10.00', 'player-1', 'BRL'));
    const usdWallet = await useCase.execute(command('10.00', 'player-1', 'USD'));

    expect(brlWallet.id).not.toBe(usdWallet.id);
    expect(uow.database.wallets.rows()).toHaveLength(2);
  });

  it('rejects a negative initial balance without persisting anything', async () => {
    const { uow, useCase } = createHarness();

    const error = await captureError(() => useCase.execute(command('-1.00')));

    expect(error).toBeInstanceOf(InvalidMoneyError);
    expect(uow.database.wallets.rows()).toEqual([]);
    expect(uow.database.houseAccounts.rows()).toEqual([]);
  });

  it('runs inside the create wallet span', async () => {
    const { tracer, enriched, useCase } = createHarness();

    const view = await useCase.execute(command('0.00'));

    expect(tracer.spans.map((span) => span.name)).toEqual(['usecase.create-wallet']);
    expect(enriched).toEqual([{ walletId: view.id }]);
  });
});
