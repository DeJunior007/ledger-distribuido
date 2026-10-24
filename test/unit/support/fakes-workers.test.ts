import { describe, expect, it } from 'bun:test';
import type { PendingReferenceRetry } from '@application/ports/repositories/pending-reference-repository.port';
import type { Repositories } from '@application/ports/unit-of-work.port';
import { Money } from '@domain/shared/money';
import { WagerTransaction } from '@domain/wagering/wager-transaction';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { HouseAccountPurpose } from '@domain/wallet/house-account';
import { Wallet } from '@domain/wallet/wallet';
import { InMemoryUnitOfWork } from '@test/support/fakes/in-memory-unit-of-work.fake';
import { FixedClock } from '@test/support/fixed-clock';

const start = new Date('2026-03-01T12:00:00.000Z');

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const required = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new TypeError('expected a value');
  }
  return value;
};

const setup = (): { clock: FixedClock; uow: InMemoryUnitOfWork } => {
  const clock = new FixedClock(start);
  return { clock, uow: new InMemoryUnitOfWork(clock) };
};

const retry = (transactionId: string, overrides: Partial<PendingReferenceRetry> = {}) => ({
  transactionId,
  attempts: 0,
  consecutiveErrors: 0,
  nextAttemptAt: start,
  deadlineAt: new Date(start.getTime() + 60_000),
  lockedUntil: undefined,
  lockedBy: undefined,
  resolvedAt: undefined,
  createdAt: start,
  ...overrides,
});

const insertRetries = (uow: InMemoryUnitOfWork, ...retries: PendingReferenceRetry[]) =>
  uow.run('write', (repos) => {
    for (const item of retries) {
      repos.pendingReferences.insert(item);
    }
    return Promise.resolve();
  });

const claim = (uow: InMemoryUnitOfWork, instanceId: string, limit = 10) =>
  uow.run('short', (repos) =>
    repos.pendingReferences.claimDue({ instanceId, leaseMs: 30_000, limit }),
  );

const pendingRefund = (id: string, referenceExternalTransactionId: string): WagerTransaction => {
  const refund = WagerTransaction.create({
    id,
    providerId: 'provider-1',
    externalTransactionId: `ext-${id}`,
    idempotencyKey: `key-${id}`,
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Refund,
    money: brl('10.00'),
    referenceExternalTransactionId,
    correlationId: 'correlation-1',
    now: start,
  });
  refund.markPendingReference({ balanceSnapshot: brl('100.00'), at: start });
  return refund;
};

const seedWallet = async (uow: InMemoryUnitOfWork, id: string): Promise<void> => {
  await uow.run('write', async (repos) => {
    await repos.houseAccounts.ensure('BRL', HouseAccountPurpose.Funding, 'funding-brl', start);
    await repos.houseAccounts.ensure('BRL', HouseAccountPurpose.Gaming, 'gaming-brl', start);
    const { wallet, posting } = Wallet.open({
      id,
      playerId: `player-${id}`,
      initialBalance: brl('100.00'),
      openingTransactionId: `${id}-opening`,
      fundingAccountId: 'funding-brl',
      walletEntryId: `${id}-wallet-entry-0`,
      houseEntryId: `${id}-house-entry-0`,
      now: start,
    });
    repos.wallets.insert(wallet);
    repos.ledger.insertPosting(required(posting));
    await repos.flush();
  });
};

const bet = async (uow: InMemoryUnitOfWork, walletId: string): Promise<void> => {
  await uow.run('write', async (repos: Repositories) => {
    const { wallet } = required(await repos.wallets.lockById(walletId));
    const posting = wallet.debit({
      transactionId: 'bet-1',
      money: brl('30.00'),
      houseAccountId: 'gaming-brl',
      walletEntryId: 'bet-wallet-entry',
      houseEntryId: 'bet-house-entry',
      now: start,
    });
    repos.wallets.update(wallet);
    repos.ledger.insertPosting(posting);
    await repos.flush();
  });
};

describe('in-memory pending reference repository', () => {
  it('claims due retries with a lease and the claiming instance', async () => {
    const { clock, uow } = setup();
    await insertRetries(
      uow,
      retry('a'),
      retry('b', { nextAttemptAt: new Date(start.getTime() + 5_000) }),
    );

    const claimed = await claim(uow, 'instance-1');

    expect(claimed.map((item) => item.transactionId)).toEqual(['a']);
    expect(claimed[0]?.lockedBy).toBe('instance-1');
    expect(claimed[0]?.lockedUntil).toEqual(new Date(start.getTime() + 30_000));
    expect(await claim(uow, 'instance-2')).toHaveLength(0);

    clock.advance(31_000);

    const reclaimed = await claim(uow, 'instance-2');
    expect(reclaimed.map((item) => item.transactionId).sort()).toEqual(['a', 'b']);
  });

  it('respects the claim limit and orders by next attempt', async () => {
    const { uow } = setup();
    await insertRetries(
      uow,
      retry('late', { nextAttemptAt: new Date(start.getTime() - 1_000) }),
      retry('early', { nextAttemptAt: new Date(start.getTime() - 9_000) }),
      retry('mid', { nextAttemptAt: new Date(start.getTime() - 5_000) }),
    );

    const claimed = await claim(uow, 'instance-1', 2);

    expect(claimed.map((item) => item.transactionId)).toEqual(['early', 'mid']);
  });

  it('skips rows locked by another open transaction', async () => {
    const { uow } = setup();
    await insertRetries(uow, retry('a'));
    const gate: PromiseWithResolvers<void> = Promise.withResolvers();
    const holder = uow.run('short', async (repos) => {
      const first = await repos.pendingReferences.claimDue({
        instanceId: 'instance-1',
        leaseMs: 1,
        limit: 1,
      });
      await gate.promise;
      return first;
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    const concurrent = await claim(uow, 'instance-2');
    gate.resolve();

    expect(concurrent).toHaveLength(0);
    expect(await holder).toHaveLength(1);
  });

  it('renews the lease only for the owner of an open retry', async () => {
    const { clock, uow } = setup();
    await insertRetries(uow, retry('a'));
    await claim(uow, 'instance-1');
    clock.advance(10_000);

    const renewed = await uow.run('short', (repos) =>
      repos.pendingReferences.renewLease('a', 'instance-1', 30_000),
    );
    const stolen = await uow.run('short', (repos) =>
      repos.pendingReferences.renewLease('a', 'instance-2', 30_000),
    );

    expect(renewed).toBe(true);
    expect(stolen).toBe(false);
    expect(required(uow.database.pendingReferences.get('a')).lockedUntil).toEqual(
      new Date(start.getTime() + 40_000),
    );
  });

  it('schedules the next attempt and releases the lease', async () => {
    const { uow } = setup();
    await insertRetries(uow, retry('a'));
    await claim(uow, 'instance-1');
    const next = new Date(start.getTime() + 8_000);

    const foreign = await uow.run('short', (repos) =>
      repos.pendingReferences.scheduleNext({
        transactionId: 'a',
        instanceId: 'instance-2',
        nextAttemptAt: next,
        attempts: 1,
        consecutiveErrors: 0,
      }),
    );
    const scheduled = await uow.run('short', (repos) =>
      repos.pendingReferences.scheduleNext({
        transactionId: 'a',
        instanceId: 'instance-1',
        nextAttemptAt: next,
        attempts: 1,
        consecutiveErrors: 2,
      }),
    );

    expect(foreign).toBe(false);
    expect(scheduled).toBe(true);
    expect(uow.database.pendingReferences.get('a')).toMatchObject({
      attempts: 1,
      consecutiveErrors: 2,
      nextAttemptAt: next,
      lockedUntil: undefined,
      lockedBy: undefined,
    });
  });

  it('marks a retry resolved once and stops counting it as open', async () => {
    const { uow } = setup();
    await insertRetries(uow, retry('a'), retry('b'));
    const resolvedAt = new Date(start.getTime() + 1_000);

    await uow.run('write', (repos) => repos.pendingReferences.markResolved('a', resolvedAt));
    await uow.run('write', (repos) =>
      repos.pendingReferences.markResolved('a', new Date(start.getTime() + 9_000)),
    );

    const open = await uow.run('short', (repos) => repos.pendingReferences.openCount());
    expect(open).toBe(1);
    expect(required(uow.database.pendingReferences.get('a')).resolvedAt).toEqual(resolvedAt);
    expect((await claim(uow, 'instance-1')).map((item) => item.transactionId)).toEqual(['b']);
  });

  it('wakes only open dependents of the referenced external transaction', async () => {
    const { uow } = setup();
    const later = new Date(start.getTime() + 30_000);
    await uow.run('write', (repos) => {
      repos.transactions.insert(pendingRefund('waiting', 'ext-bet'));
      repos.transactions.insert(pendingRefund('other', 'ext-elsewhere'));
      repos.transactions.insert(pendingRefund('done', 'ext-bet'));
      repos.transactions.insert(pendingRefund('due', 'ext-bet'));
      repos.pendingReferences.insert(retry('waiting', { nextAttemptAt: later }));
      repos.pendingReferences.insert(retry('other', { nextAttemptAt: later }));
      repos.pendingReferences.insert(retry('done', { nextAttemptAt: later, resolvedAt: start }));
      repos.pendingReferences.insert(retry('due'));
      return Promise.resolve();
    });

    const woken = await uow.run('write', (repos) =>
      repos.pendingReferences.wakeDependents('provider-1', 'ext-bet'),
    );

    expect(woken).toBe(1);
    expect(required(uow.database.pendingReferences.get('waiting')).nextAttemptAt).toEqual(start);
    expect(required(uow.database.pendingReferences.get('other')).nextAttemptAt).toEqual(later);
    expect(required(uow.database.pendingReferences.get('done')).nextAttemptAt).toEqual(later);
  });
});

describe('in-memory scheduled job repository', () => {
  const acquire = (uow: InMemoryUnitOfWork, instanceId: string, minIntervalMs = 0) =>
    uow.run('short', (repos) =>
      repos.scheduledJobs.tryAcquire('global-reconciliation', instanceId, 60_000, minIntervalMs),
    );

  it('grants the lease to one instance at a time', async () => {
    const { clock, uow } = setup();

    expect(await acquire(uow, 'instance-1')).toBe(true);
    expect(await acquire(uow, 'instance-2')).toBe(false);
    expect(uow.database.scheduledJobs.get('global-reconciliation')?.lockedBy).toBe('instance-1');

    clock.advance(61_000);

    expect(await acquire(uow, 'instance-2')).toBe(true);
  });

  it('serializes concurrent acquisitions', async () => {
    const { uow } = setup();

    const results = await Promise.all([acquire(uow, 'instance-1'), acquire(uow, 'instance-2')]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('denies unknown jobs', async () => {
    const { uow } = setup();

    const acquired = await uow.run('short', (repos) =>
      repos.scheduledJobs.tryAcquire('unknown', 'instance-1', 1_000, 0),
    );

    expect(acquired).toBe(false);
  });

  it('holds the next run until the minimum interval has passed', async () => {
    const { clock, uow } = setup();
    await acquire(uow, 'instance-1', 120_000);
    await uow.run('short', (repos) =>
      repos.scheduledJobs.complete('global-reconciliation', 'instance-1', clock.now()),
    );

    expect(await acquire(uow, 'instance-2', 120_000)).toBe(false);

    clock.advance(120_000);

    expect(await acquire(uow, 'instance-2', 120_000)).toBe(true);
  });

  it('completes only for the instance that holds the lease', async () => {
    const { clock, uow } = setup();
    await acquire(uow, 'instance-1');

    await uow.run('short', (repos) =>
      repos.scheduledJobs.complete('global-reconciliation', 'instance-2', clock.now()),
    );
    expect(uow.database.scheduledJobs.get('global-reconciliation')?.lockedBy).toBe('instance-1');

    await uow.run('short', (repos) =>
      repos.scheduledJobs.complete('global-reconciliation', 'instance-1', clock.now()),
    );
    expect(uow.database.scheduledJobs.get('global-reconciliation')).toMatchObject({
      lockedBy: undefined,
      lockedUntil: undefined,
      lastRunAt: start,
    });
  });
});

describe('in-memory reconciliation repository', () => {
  it('computes a wallet snapshot from the ledger entries', async () => {
    const { uow } = setup();
    await seedWallet(uow, 'wallet-1');
    await bet(uow, 'wallet-1');

    const snapshot = await uow.run('reconciliation', (repos) =>
      repos.reconciliation.walletSnapshot('wallet-1'),
    );

    expect(snapshot).toMatchObject({
      walletId: 'wallet-1',
      currency: 'BRL',
      balance: '70.00',
      version: 2,
      credits: '100.00',
      debits: '30.00',
      entries: 2,
    });
    expect(snapshot?.chain.map((link) => link.walletVersion)).toEqual([1, 2]);
    expect(snapshot?.chain[1]).toMatchObject({
      direction: 'DEBIT',
      amount: '30.00',
      balanceBefore: '100.00',
      balanceAfter: '70.00',
    });
  });

  it('returns undefined for an unknown wallet', async () => {
    const { uow } = setup();

    expect(
      await uow.run('reconciliation', (repos) => repos.reconciliation.walletSnapshot('missing')),
    ).toBe(undefined);
  });

  it('sums wallets, house accounts and ledger per currency', async () => {
    const { uow } = setup();
    await seedWallet(uow, 'wallet-1');
    await bet(uow, 'wallet-1');

    const sums = await uow.run('reconciliation', (repos) => repos.reconciliation.globalSums());

    expect(sums).toEqual([
      {
        currency: 'BRL',
        walletsTotal: '70.00',
        fundingBalance: '-100.00',
        gamingBalance: '30.00',
        ledgerNet: '0.00',
      },
    ]);
  });

  it('pages wallets by id keyset with calculated balances', async () => {
    const { uow } = setup();
    await seedWallet(uow, 'wallet-1');
    await bet(uow, 'wallet-1');
    await uow.run('write', async (repos) => {
      const { wallet } = Wallet.open({
        id: 'wallet-2',
        playerId: 'player-2',
        initialBalance: Money.zero('BRL'),
        openingTransactionId: 'wallet-2-opening',
        fundingAccountId: 'funding-brl',
        walletEntryId: 'wallet-2-wallet-entry-0',
        houseEntryId: 'wallet-2-house-entry-0',
        now: start,
      });
      repos.wallets.insert(wallet);
      await repos.flush();
    });

    const first = await uow.run('reconciliation', (repos) =>
      repos.reconciliation.walletBatch(undefined, 1),
    );
    const second = await uow.run('reconciliation', (repos) =>
      repos.reconciliation.walletBatch('wallet-1', 5),
    );

    expect(first).toEqual([
      {
        walletId: 'wallet-1',
        balance: '70.00',
        version: 2,
        calculated: '70.00',
        entries: 2,
        firstVersion: 1,
        lastVersion: 2,
      },
    ]);
    expect(second).toEqual([
      {
        walletId: 'wallet-2',
        balance: '0.00',
        version: 1,
        calculated: '0.00',
        entries: 0,
        firstVersion: undefined,
        lastVersion: undefined,
      },
    ]);
  });

  it('stores reconciliation runs', async () => {
    const { uow } = setup();

    await uow.run('short', (repos) => {
      repos.reconciliation.insertRun({
        id: 'run-1',
        scope: 'GLOBAL',
        walletId: undefined,
        consistent: true,
        checkedEntries: 2,
        stored: undefined,
        calculated: undefined,
        difference: undefined,
        currency: undefined,
        firstDivergentVersion: undefined,
        details: { walletsChecked: 1 },
        startedAt: start,
        finishedAt: start,
      });
      return Promise.resolve();
    });

    expect(uow.database.reconciliationRuns.get('run-1')).toMatchObject({
      scope: 'GLOBAL',
      consistent: true,
      details: { walletsChecked: 1 },
    });
  });
});
