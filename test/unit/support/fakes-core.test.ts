import { describe, expect, it } from 'bun:test';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import { RollbackSignal } from '@application/errors/rollback-signal';
import type { Repositories } from '@application/ports/unit-of-work.port';
import { IdempotencyRecord } from '@domain/idempotency/idempotency-record';
import { InboxMessage } from '@domain/messaging/inbox-message';
import { OutboxMessage } from '@domain/messaging/outbox-message';
import { Money } from '@domain/shared/money';
import { WagerTransaction } from '@domain/wagering/wager-transaction';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { HouseAccountPurpose } from '@domain/wallet/house-account';
import { Wallet } from '@domain/wallet/wallet';
import { FakeFaultInjector, InjectedFaultError } from '@test/support/fakes/fault-injector.fake';
import { InMemoryUnitOfWork } from '@test/support/fakes/in-memory-unit-of-work.fake';
import { FakeLogger } from '@test/support/fakes/logger.fake';
import { FakeMetrics } from '@test/support/fakes/metrics.fake';
import { FakeTracer } from '@test/support/fakes/tracer.fake';
import { FixedClock } from '@test/support/fixed-clock';

const now = new Date('2026-03-01T12:00:00.000Z');

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const required = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new TypeError('expected a value');
  }
  return value;
};

const captureError = async (action: () => Promise<unknown>): Promise<unknown> => {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return undefined;
};

const expectConstraint = (
  error: unknown,
  errorClass: TechnicalError['errorClass'],
  constraint: string,
): void => {
  expect(error).toBeInstanceOf(TechnicalError);
  if (error instanceof TechnicalError) {
    expect(error.errorClass).toBe(errorClass);
    expect(error.constraint).toBe(constraint);
  }
};

const yieldToEventLoop = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

const createUnitOfWork = (): InMemoryUnitOfWork => new InMemoryUnitOfWork(new FixedClock(now));

const openWallet = (id: string, playerId = `player-${id}`, amount = '100.00') =>
  Wallet.open({
    id,
    playerId,
    initialBalance: brl(amount),
    openingTransactionId: `${id}-opening`,
    fundingAccountId: 'funding-brl',
    walletEntryId: `${id}-wallet-entry-0`,
    houseEntryId: `${id}-house-entry-0`,
    now,
  });

const seedWallet = async (uow: InMemoryUnitOfWork, id: string): Promise<void> => {
  await uow.run('write', async (repos) => {
    await repos.houseAccounts.ensure('BRL', HouseAccountPurpose.Funding, 'funding-brl', now);
    await repos.houseAccounts.ensure('BRL', HouseAccountPurpose.Gaming, 'gaming-brl', now);
    const { wallet, posting } = openWallet(id);
    repos.wallets.insert(wallet);
    repos.ledger.insertPosting(required(posting));
    await repos.flush();
    await repos.wallets.assertPersistedVersion(wallet);
  });
};

const debit = async (
  repos: Repositories,
  wallet: Wallet,
  sequence: number,
  amount = '10.00',
): Promise<void> => {
  const posting = wallet.debit({
    transactionId: `tx-${String(sequence)}`,
    money: brl(amount),
    houseAccountId: 'gaming-brl',
    walletEntryId: `wallet-entry-${String(sequence)}`,
    houseEntryId: `house-entry-${String(sequence)}`,
    now,
  });
  repos.wallets.update(wallet);
  repos.ledger.insertPosting(posting);
  await repos.flush();
  await repos.wallets.assertPersistedVersion(wallet);
};

const lockedBet = (
  uow: InMemoryUnitOfWork,
  walletId: string,
  sequence: number,
  gate: Promise<void> = Promise.resolve(),
): Promise<boolean> =>
  uow.run('write', async (repos) => {
    const locked = required(await repos.wallets.lockById(walletId));
    await gate;
    await debit(repos, locked.wallet, sequence);
    return locked.contended;
  });

const wagerTransaction = (
  overrides: Partial<{
    id: string;
    externalTransactionId: string;
    idempotencyKey: string;
    kind: WagerTransactionKind;
    referenceExternalTransactionId: string;
  }> = {},
): WagerTransaction =>
  WagerTransaction.create({
    id: overrides.id ?? 'tx-1',
    providerId: 'provider-1',
    externalTransactionId: overrides.externalTransactionId ?? 'ext-1',
    idempotencyKey: overrides.idempotencyKey ?? 'key-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-wallet-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: overrides.kind ?? WagerTransactionKind.Bet,
    money: brl('10.00'),
    referenceExternalTransactionId: overrides.referenceExternalTransactionId,
    correlationId: 'correlation-1',
    now,
  });

const processedRefund = (id: string, externalTransactionId: string): WagerTransaction => {
  const refund = wagerTransaction({
    id,
    externalTransactionId,
    idempotencyKey: `key-${id}`,
    kind: WagerTransactionKind.Refund,
    referenceExternalTransactionId: 'ext-bet',
  });
  refund.markProcessed({ referenceTransactionId: 'bet-1', balanceSnapshot: brl('10.00'), at: now });
  return refund;
};

const idempotencyRecord = (key = 'key-1'): IdempotencyRecord =>
  IdempotencyRecord.create({
    providerId: 'provider-1',
    idempotencyKey: key,
    payloadHash: 'hash-1',
    transactionId: 'tx-1',
    httpStatus: 202,
    responseBody: {
      transactionId: 'tx-1',
      status: 'PENDING_REFERENCE',
      kind: WagerTransactionKind.Bet,
      balance: null,
      idempotentReplay: false,
    },
    createdAt: now,
  });

const inboxMessage = (): InboxMessage =>
  InboxMessage.receive({
    consumerName: 'wager-transactions-consumer',
    messageId: 'message-1',
    payloadHash: 'hash-1',
    now,
  });

const outboxMessage = (id: string, overrides: { attempts?: number; parkedAt?: Date } = {}) =>
  OutboxMessage.rehydrate({
    id,
    aggregateId: 'wallet-1',
    eventType: 'WalletBalanceChanged',
    payload: { eventId: id },
    occurredAt: new Date(now.getTime() - 30_000),
    attempts: overrides.attempts ?? 0,
    permanentFailures: 0,
    nextAttemptAt: new Date(now.getTime() - 1_000),
    lockedUntil: undefined,
    lockedBy: undefined,
    publishedAt: undefined,
    parkedAt: overrides.parkedAt,
    lastErrorCode: undefined,
  });

const writeEverything = async (repos: Repositories): Promise<void> => {
  await repos.houseAccounts.ensure('BRL', HouseAccountPurpose.Funding, 'funding-brl', now);
  const { wallet, posting } = openWallet('wallet-1', 'player-wallet-1');
  repos.wallets.insert(wallet);
  repos.ledger.insertPosting(required(posting));
  repos.transactions.insert(wagerTransaction());
  repos.idempotency.insert(idempotencyRecord());
  await repos.inbox.tryInsert(inboxMessage());
  repos.outbox.enqueue(outboxMessage('event-1'));
  await repos.flush();
};

const storedRowCounts = (uow: InMemoryUnitOfWork): number[] => {
  const { database } = uow;
  return [
    database.wallets.rows().length,
    database.houseAccounts.rows().length,
    database.transactions.rows().length,
    database.walletEntries.rows().length,
    database.houseEntries.rows().length,
    database.idempotency.rows().length,
    database.inbox.rows().length,
    database.outbox.rows().length,
  ];
};

describe('InMemoryUnitOfWork', () => {
  it('commits every write when the work succeeds', async () => {
    const uow = createUnitOfWork();

    await uow.run('write', writeEverything);

    expect(storedRowCounts(uow)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    const found = await uow.read((repos) => repos.wallets.findById('wallet-1'));
    expect(found?.balance.equals(brl('100.00'))).toBe(true);
    expect(found?.version).toBe(1);
  });

  it('rolls back everything and rethrows the same RollbackSignal', async () => {
    const uow = createUnitOfWork();
    const signal = new RollbackSignal({ outcome: 'rejected' });

    const error = await captureError(() =>
      uow.run('write', async (repos) => {
        await writeEverything(repos);
        throw signal;
      }),
    );

    expect(error).toBe(signal);
    expect(storedRowCounts(uow)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('rolls back everything when the work fails with any other error', async () => {
    const uow = createUnitOfWork();
    const failure = new TechnicalError(ErrorClass.Transient, 'lock_timeout');

    const error = await captureError(() =>
      uow.run('write', async (repos) => {
        await writeEverything(repos);
        throw failure;
      }),
    );

    expect(error).toBe(failure);
    expect(storedRowCounts(uow)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('never persists what a read session writes', async () => {
    const uow = createUnitOfWork();

    await uow.read((repos) => {
      repos.idempotency.insert(idempotencyRecord());
      return repos.inbox.tryInsert(inboxMessage());
    });

    expect(uow.database.idempotency.rows()).toHaveLength(0);
    expect(uow.database.inbox.rows()).toHaveLength(0);
  });

  it('hands out detached copies so mutations without update never leak', async () => {
    const uow = createUnitOfWork();
    await seedWallet(uow, 'wallet-1');

    await uow.run('write', async (repos) => {
      const wallet = required(await repos.wallets.findById('wallet-1'));
      wallet.debit({
        transactionId: 'tx-1',
        money: brl('10.00'),
        houseAccountId: 'gaming-brl',
        walletEntryId: 'wallet-entry-1',
        houseEntryId: 'house-entry-1',
        now,
      });
    });

    const stored = await uow.read((repos) => repos.wallets.findById('wallet-1'));
    expect(stored?.balance.equals(brl('100.00'))).toBe(true);
  });

  it('turns a conflicting commit injected before the commit into a race', async () => {
    const uow = createUnitOfWork();
    uow.interceptNextCommit(() =>
      uow.run('write', (repos) => {
        repos.idempotency.insert(idempotencyRecord());
        return Promise.resolve();
      }),
    );

    const error = await captureError(() =>
      uow.run('write', (repos) => {
        repos.idempotency.insert(idempotencyRecord());
        return Promise.resolve();
      }),
    );

    expectConstraint(error, ErrorClass.Race, 'idempotency_records_pkey');
    expect(uow.database.idempotency.rows()).toHaveLength(1);
  });
});

describe('simulated unique constraints', () => {
  it('raises a race when the idempotency key was already committed', async () => {
    const uow = createUnitOfWork();
    await uow.run('write', (repos) => {
      repos.idempotency.insert(idempotencyRecord());
      return Promise.resolve();
    });

    const error = await captureError(() =>
      uow.run('write', async (repos) => {
        repos.idempotency.insert(idempotencyRecord());
        await repos.flush();
      }),
    );

    expectConstraint(error, ErrorClass.Race, 'idempotency_records_pkey');
  });

  it('raises a race for a repeated idempotency key on wager transactions', async () => {
    const uow = createUnitOfWork();
    await uow.run('write', (repos) => {
      repos.transactions.insert(wagerTransaction());
      return Promise.resolve();
    });

    const error = await captureError(() =>
      uow.run('write', (repos) => {
        repos.transactions.insert(wagerTransaction({ id: 'tx-2', externalTransactionId: 'ext-2' }));
        return Promise.resolve();
      }),
    );

    expectConstraint(error, ErrorClass.Race, 'wager_transactions_provider_key_uq');
  });

  it('raises a race for a repeated provider and external transaction id', async () => {
    const uow = createUnitOfWork();

    const error = await captureError(() =>
      uow.run('write', async (repos) => {
        repos.transactions.insert(wagerTransaction());
        repos.transactions.insert(wagerTransaction({ id: 'tx-2', idempotencyKey: 'key-2' }));
        await repos.flush();
      }),
    );

    expectConstraint(error, ErrorClass.Race, 'wager_transactions_provider_external_uq');
    expect(uow.database.transactions.rows()).toHaveLength(0);
  });

  it('raises a race when a second reversal of the same transaction is processed', async () => {
    const uow = createUnitOfWork();
    await uow.run('write', (repos) => {
      repos.transactions.insert(processedRefund('refund-1', 'ext-refund-1'));
      return Promise.resolve();
    });

    const reversed = await uow.read((repos) => repos.transactions.isReversed('bet-1'));
    const error = await captureError(() =>
      uow.run('write', (repos) => {
        repos.transactions.insert(processedRefund('refund-2', 'ext-refund-2'));
        return Promise.resolve();
      }),
    );

    expect(reversed).toBe(true);
    expectConstraint(error, ErrorClass.Race, 'wager_transactions_single_reversal_uq');
  });

  it('raises a race when a concurrent consumer committed the same inbox message first', async () => {
    const uow = createUnitOfWork();
    const gate = Promise.withResolvers<undefined>();

    const slow = uow.run('write', async (repos) => {
      const inserted = await repos.inbox.tryInsert(inboxMessage());
      await gate.promise;
      return inserted;
    });
    const fast = await uow.run('write', (repos) => repos.inbox.tryInsert(inboxMessage()));
    gate.resolve(undefined);
    const error = await captureError(() => slow);

    expect(fast).toBe(true);
    expectConstraint(error, ErrorClass.Race, 'inbox_messages_pkey');
    expect(uow.database.inbox.rows()).toHaveLength(1);
  });

  it('answers false when the inbox message is already visible', async () => {
    const uow = createUnitOfWork();
    await uow.run('write', (repos) => repos.inbox.tryInsert(inboxMessage()));

    const inserted = await uow.run('write', (repos) => repos.inbox.tryInsert(inboxMessage()));

    expect(inserted).toBe(false);
  });

  it('raises a race for a second wallet of the same player and currency', async () => {
    const uow = createUnitOfWork();
    await seedWallet(uow, 'wallet-1');

    const error = await captureError(() =>
      uow.run('write', async (repos) => {
        repos.wallets.insert(openWallet('wallet-2', 'player-wallet-1').wallet);
        await repos.flush();
      }),
    );

    expectConstraint(error, ErrorClass.Race, 'wallets_player_currency_uq');
  });
});

describe('InMemoryWalletRepository', () => {
  it('serializes concurrent lockById calls on the same wallet', async () => {
    const uow = createUnitOfWork();
    await seedWallet(uow, 'wallet-1');
    const gate = Promise.withResolvers<undefined>();
    let secondFinished = false;

    const first = lockedBet(uow, 'wallet-1', 1, gate.promise);
    const second = lockedBet(uow, 'wallet-1', 2).then((contended) => {
      secondFinished = true;
      return contended;
    });
    await yieldToEventLoop();
    const finishedWhileLocked = secondFinished;
    gate.resolve(undefined);
    const [firstContended, secondContended] = await Promise.all([first, second]);

    expect(finishedWhileLocked).toBe(false);
    expect(firstContended).toBe(false);
    expect(secondContended).toBe(true);
    const stored = required(uow.database.wallets.get('wallet-1'));
    expect(stored.balance.equals(brl('80.00'))).toBe(true);
    expect(stored.version).toBe(3);
    const entries = await uow.read((repos) =>
      repos.ledger.listWalletEntries('wallet-1', { beforeVersion: undefined, limit: 10 }),
    );
    expect(entries.map((entry) => entry.walletVersion)).toEqual([3, 2, 1]);
  });

  it('releases the lock on rollback so the next caller proceeds', async () => {
    const uow = createUnitOfWork();
    await seedWallet(uow, 'wallet-1');

    await captureError(() =>
      uow.run('write', async (repos) => {
        await repos.wallets.lockById('wallet-1');
        throw new RollbackSignal(undefined);
      }),
    );
    const contended = await lockedBet(uow, 'wallet-1', 1);

    expect(contended).toBe(false);
  });

  it('reports drift when the update was not flushed before the version check', async () => {
    const uow = createUnitOfWork();
    await seedWallet(uow, 'wallet-1');

    const error = await captureError(() =>
      uow.run('write', async (repos) => {
        const locked = required(await repos.wallets.lockById('wallet-1'));
        locked.wallet.debit({
          transactionId: 'tx-1',
          money: brl('10.00'),
          houseAccountId: 'gaming-brl',
          walletEntryId: 'wallet-entry-1',
          houseEntryId: 'house-entry-1',
          now,
        });
        repos.wallets.update(locked.wallet);
        await repos.wallets.assertPersistedVersion(locked.wallet);
      }),
    );

    expect(error).toBeInstanceOf(TechnicalError);
    if (error instanceof TechnicalError) {
      expect(error.errorClass).toBe(ErrorClass.Deterministic);
      expect(error.reason).toBe('wallet_version_drift');
    }
  });

  it('raises a version mismatch for concurrent updates without the lock', async () => {
    const uow = createUnitOfWork();
    await seedWallet(uow, 'wallet-1');
    const gate = Promise.withResolvers<undefined>();

    const stale = uow.run('write', async (repos) => {
      const wallet = required(await repos.wallets.findById('wallet-1'));
      await gate.promise;
      await debit(repos, wallet, 1);
    });
    await lockedBet(uow, 'wallet-1', 2);
    gate.resolve(undefined);
    const error = await captureError(() => stale);

    expect(error).toBeInstanceOf(TechnicalError);
    if (error instanceof TechnicalError) {
      expect(error.errorClass).toBe(ErrorClass.Transient);
      expect(error.reason).toBe('version_mismatch');
    }
    expect(uow.database.wallets.get('wallet-1')?.balance.equals(brl('90.00'))).toBe(true);
  });

  it('pages wallet entries before a version', async () => {
    const uow = createUnitOfWork();
    await seedWallet(uow, 'wallet-1');
    await lockedBet(uow, 'wallet-1', 1);
    await lockedBet(uow, 'wallet-1', 2);

    const page = await uow.read((repos) =>
      repos.ledger.listWalletEntries('wallet-1', { beforeVersion: 3, limit: 1 }),
    );

    expect(page.map((entry) => entry.walletVersion)).toEqual([2]);
  });
});

describe('InMemoryHouseAccountRepository', () => {
  it('reuses the account that already exists for the currency and purpose', async () => {
    const uow = createUnitOfWork();

    const [first, second] = await uow.run('write', async (repos) => [
      await repos.houseAccounts.ensure('BRL', HouseAccountPurpose.Gaming, 'gaming-1', now),
      await repos.houseAccounts.ensure('BRL', HouseAccountPurpose.Gaming, 'gaming-2', now),
    ]);

    expect(first.id).toBe('gaming-1');
    expect(second.id).toBe('gaming-1');
    expect(uow.database.houseAccounts.rows()).toHaveLength(1);
  });
});

describe('InMemoryOutboxRepository', () => {
  it('leases due events to one instance and only that instance marks them published', async () => {
    const uow = createUnitOfWork();
    await uow.run('write', (repos) => {
      repos.outbox.enqueue(outboxMessage('event-1'));
      return Promise.resolve();
    });

    const claimedByA = await uow.run('short', (repos) =>
      repos.outbox.claimDue({ instanceId: 'a', leaseMs: 30_000, limit: 10 }),
    );
    const claimedByB = await uow.run('short', (repos) =>
      repos.outbox.claimDue({ instanceId: 'b', leaseMs: 30_000, limit: 10 }),
    );
    const markedByB = await uow.run('short', (repos) =>
      repos.outbox.markPublished('event-1', 'b', now),
    );
    const markedByA = await uow.run('short', (repos) =>
      repos.outbox.markPublished('event-1', 'a', now),
    );

    expect(claimedByA.map((message) => message.id)).toEqual(['event-1']);
    expect(claimedByB).toHaveLength(0);
    expect(markedByB).toBe(false);
    expect(markedByA).toBe(true);
    expect(uow.database.outbox.get('event-1')?.publishedAt).toEqual(now);
  });

  it('skips rows claimed by a transaction that is still open', async () => {
    const uow = createUnitOfWork();
    await uow.run('write', (repos) => {
      repos.outbox.enqueue(outboxMessage('event-1'));
      return Promise.resolve();
    });
    const gate = Promise.withResolvers<undefined>();

    const holding = uow.run('short', async (repos) => {
      const claimed = await repos.outbox.claimDue({ instanceId: 'a', leaseMs: 30_000, limit: 10 });
      await gate.promise;
      return claimed;
    });
    const concurrent = await uow.run('short', (repos) =>
      repos.outbox.claimDue({ instanceId: 'b', leaseMs: 30_000, limit: 10 }),
    );
    gate.resolve(undefined);

    expect(concurrent).toHaveLength(0);
    expect(await holding).toHaveLength(1);
  });

  it('computes gauges and requeues parked events', async () => {
    const uow = createUnitOfWork();
    await uow.run('write', (repos) => {
      repos.outbox.enqueue(outboxMessage('event-1', { attempts: 10 }));
      repos.outbox.enqueue(outboxMessage('event-2', { parkedAt: now }));
      return Promise.resolve();
    });

    const gauges = await uow.run('short', (repos) => repos.outbox.gauges(now));
    const requeued = await uow.run('short', (repos) => repos.outbox.requeueParked(undefined));

    expect(gauges).toEqual({ pending: 1, parked: 1, stuck: 1, lagSeconds: 30 });
    expect(requeued).toBe(1);
    expect(uow.database.outbox.get('event-2')?.nextAttemptAt).toEqual(now);
  });
});

describe('port fakes', () => {
  it('records metric series by name and labels', () => {
    const metrics = new FakeMetrics();

    metrics.transactionRecorded({
      status: 'PROCESSED',
      kind: 'BET',
      channel: 'http',
      failureCode: 'none',
    });
    metrics.lockConflict('contended');
    metrics.walletLockWait('http', 0.5);
    metrics.setCircuitBreaker('consumer', true);

    expect(
      metrics.counter('wager_transactions_total', {
        status: 'PROCESSED',
        kind: 'BET',
        channel: 'http',
        failure_code: 'none',
      }),
    ).toBe(1);
    expect(metrics.counter('lock_conflicts_total', { type: 'contended' })).toBe(1);
    expect(metrics.observations('wallet_lock_wait_seconds', { channel: 'http' })).toEqual([0.5]);
    expect(metrics.gauge('circuit_breaker_open', { component: 'consumer' })).toBe(1);
  });

  it('records log entries per level', () => {
    const logger = new FakeLogger();

    logger.warn('lease lost', { component: 'outbox' });

    expect(logger.entriesAt('warn')).toEqual([
      { level: 'warn', message: 'lease lost', fields: { component: 'outbox' } },
    ]);
  });

  it('throws once at an armed fault point', () => {
    const faults = new FakeFaultInjector();
    faults.arm('api.before_commit');

    expect(() => {
      faults.hit('api.before_commit');
    }).toThrow(InjectedFaultError);
    faults.hit('api.before_commit');

    expect(faults.hits).toEqual(['api.before_commit', 'api.before_commit']);
  });

  it('runs the span body and records the span', async () => {
    const tracer = new FakeTracer();

    const result = await tracer.inSpan('submit', { channel: 'http' }, () => Promise.resolve(7));

    expect(result).toBe(7);
    expect(tracer.spans).toEqual([{ name: 'submit', attributes: { channel: 'http' } }]);
  });
});
