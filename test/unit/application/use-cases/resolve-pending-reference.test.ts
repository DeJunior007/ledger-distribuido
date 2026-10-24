import { describe, expect, it } from 'bun:test';
import { AnomalyDetector } from '@application/services/anomaly-detector';
import {
  ResolvePendingReferenceUseCase,
  waitRetryDelayMs,
} from '@application/use-cases/resolve-pending-reference.use-case';
import { FailureCode } from '@domain/shared/failure-code';
import { TransactionApplier } from '@domain/wagering/transaction-applier';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '@domain/wagering/wager-transaction-status';
import { InjectedFaultError } from '@test/support/fakes/fault-injector.fake';
import { rejection } from './fixtures';
import {
  INSTANCE_ID,
  PENDING_LEASE_MS,
  PENDING_TTL_MS,
  brl,
  createHarness,
  createdAt,
  outboxEvents,
  pendingRetry,
  seedBet,
  seedPending,
  storedRecord,
  storedRetry,
  storedTransaction,
  transactionState,
  type PendingHarness,
} from './pending-reference.fixtures';

const useCaseFor = (harness: PendingHarness): ResolvePendingReferenceUseCase =>
  new ResolvePendingReferenceUseCase(
    {
      uow: harness.uow,
      clock: harness.clock,
      ids: harness.ids,
      faults: harness.faults,
      logger: harness.logger,
      metrics: harness.metrics,
      tracer: harness.tracer,
      enrich: (fields) => {
        harness.enriched.push({ ...fields });
      },
      applier: TransactionApplier.create(),
      outcomeMapper: harness.outcomeMapper,
      anomalyDetector: new AnomalyDetector(),
    },
    { instanceId: INSTANCE_ID, pendingLeaseMs: PENDING_LEASE_MS },
  );

const seedRefund = (
  harness: PendingHarness,
  retry: Parameters<typeof seedPending>[2] = {},
): void => {
  seedPending(harness, { id: 'refund-1', kind: WagerTransactionKind.Refund }, retry);
};

const pastDeadline = (harness: PendingHarness): void => {
  harness.clock.set(new Date(createdAt.getTime() + PENDING_TTL_MS));
};

describe('ResolvePendingReferenceUseCase', () => {
  it('skips the retry when the lease was taken by another instance', async () => {
    const harness = createHarness();
    seedBet(harness);
    seedRefund(harness, { lockedBy: 'instance-2' });

    const outcome = await useCaseFor(harness).execute(pendingRetry('refund-1'));

    expect(outcome).toBe('skipped');
    expect(storedTransaction(harness, 'refund-1').status).toBe(
      WagerTransactionStatus.PendingReference,
    );
    expect(storedRetry(harness, 'refund-1').lockedBy).toBe('instance-2');
    expect(outboxEvents(harness)).toHaveLength(0);
  });

  it('marks the retry resolved when the transaction is already terminal', async () => {
    const harness = createHarness();
    seedBet(harness);
    seedRefund(harness);
    harness.uow.database.transactions.put(
      transactionState({
        id: 'refund-1',
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'ext-bet-1',
      }),
    );

    const outcome = await useCaseFor(harness).execute(pendingRetry('refund-1'));

    expect(outcome).toBe('already-resolved');
    expect(storedRetry(harness, 'refund-1').resolvedAt).toEqual(harness.clock.now());
    expect(storedRecord(harness, 'refund-1').httpStatus).toBe(202);
    expect(outboxEvents(harness)).toHaveLength(0);
    expect(harness.faults.hits).toHaveLength(0);
  });

  it('schedules the next attempt with the growing wait while the reference is missing', async () => {
    const harness = createHarness();
    seedRefund(harness, { attempts: 2, consecutiveErrors: 3 });

    const outcome = await useCaseFor(harness).execute(
      pendingRetry('refund-1', { attempts: 2, consecutiveErrors: 3 }),
    );

    const retry = storedRetry(harness, 'refund-1');
    expect(outcome).toBe('waiting');
    expect(retry.attempts).toBe(3);
    expect(retry.consecutiveErrors).toBe(0);
    expect(retry.nextAttemptAt).toEqual(new Date(harness.clock.now().getTime() + 4_000));
    expect(retry.lockedBy).toBeUndefined();
    expect(retry.resolvedAt).toBeUndefined();
    expect(storedTransaction(harness, 'refund-1').status).toBe(
      WagerTransactionStatus.PendingReference,
    );
    expect(storedRecord(harness, 'refund-1').httpStatus).toBe(202);
    expect(outboxEvents(harness)).toHaveLength(0);
    expect(harness.faults.hits).toHaveLength(0);
  });

  it('keeps waiting while the reference is still pending before the deadline', async () => {
    const harness = createHarness();
    seedBet(harness, WagerTransactionStatus.PendingReference);
    seedRefund(harness);

    const outcome = await useCaseFor(harness).execute(pendingRetry('refund-1'));

    expect(outcome).toBe('waiting');
    expect(storedRetry(harness, 'refund-1').nextAttemptAt).toEqual(
      new Date(harness.clock.now().getTime() + 1_000),
    );
  });

  it('caps the wait between attempts at sixty seconds', () => {
    expect([1, 2, 3, 6, 7, 30, 2_000].map(waitRetryDelayMs)).toEqual([
      1_000, 2_000, 4_000, 32_000, 60_000, 60_000, 60_000,
    ]);
  });

  it('rejects with REFERENCE_NOT_FOUND when the deadline passes without the reference', async () => {
    const harness = createHarness();
    seedRefund(harness);
    pastDeadline(harness);

    const outcome = await useCaseFor(harness).execute(pendingRetry('refund-1'));

    const transaction = storedTransaction(harness, 'refund-1');
    const record = storedRecord(harness, 'refund-1');
    expect(outcome).toBe('resolved');
    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(transaction.referenceTransactionId).toBeUndefined();
    expect(record.httpStatus).toBe(422);
    expect(record.responseBody).toMatchObject({
      transactionId: 'refund-1',
      status: 'REJECTED',
      failureCode: 'REFERENCE_NOT_FOUND',
      idempotentReplay: false,
    });
    expect(storedRetry(harness, 'refund-1').resolvedAt).toEqual(harness.clock.now());
    expect(outboxEvents(harness).map((event) => event.eventType)).toEqual([
      'WagerTransactionRejected',
    ]);
    expect(
      harness.metrics.counter('pending_reference_resolved_total', { outcome: 'REJECTED' }),
    ).toBe(1);
    expect(
      harness.metrics.counter('wager_transactions_total', {
        status: 'REJECTED',
        kind: 'REFUND',
        channel: 'scheduler',
        failure_code: 'REFERENCE_NOT_FOUND',
      }),
    ).toBe(1);
  });

  it('rejects with REFERENCE_NOT_PROCESSED when the reference is still pending at the deadline', async () => {
    const harness = createHarness();
    seedBet(harness, WagerTransactionStatus.PendingReference);
    seedRefund(harness);
    pastDeadline(harness);

    const outcome = await useCaseFor(harness).execute(pendingRetry('refund-1'));

    const transaction = storedTransaction(harness, 'refund-1');
    expect(outcome).toBe('resolved');
    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe(FailureCode.ReferenceNotProcessed);
    expect(transaction.referenceTransactionId).toBe('bet-1');
    expect(storedRecord(harness, 'refund-1').httpStatus).toBe(422);
    expect(storedTransaction(harness, 'bet-1').status).toBe(
      WagerTransactionStatus.PendingReference,
    );
  });

  it('applies the transaction when the reference arrived and resolves its own record', async () => {
    const harness = createHarness();
    seedBet(harness);
    seedRefund(harness);

    const outcome = await useCaseFor(harness).execute(pendingRetry('refund-1'));

    const now = harness.clock.now();
    const transaction = storedTransaction(harness, 'refund-1');
    expect(outcome).toBe('resolved');
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.referenceTransactionId).toBe('bet-1');
    expect(transaction.balanceSnapshot).toEqual(brl('130.00'));
    expect(harness.uow.database.wallets.get('wallet-1')).toMatchObject({
      balance: brl('130.00'),
      version: 3,
    });
    expect(harness.uow.database.walletEntries.rows()).toMatchObject([
      { transactionId: 'refund-1', walletVersion: 3, balanceAfter: brl('130.00') },
    ]);
    expect(harness.uow.database.houseEntries.rows()).toMatchObject([
      { transactionId: 'refund-1', houseAccountId: 'house-GAMING' },
    ]);
    const record = storedRecord(harness, 'refund-1');
    expect(record.httpStatus).toBe(200);
    expect(record.updatedAt).toEqual(now);
    expect(record.responseBody).toEqual({
      transactionId: 'refund-1',
      status: 'PROCESSED',
      kind: WagerTransactionKind.Refund,
      balance: { amount: '130.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(storedRecord(harness, 'bet-1').httpStatus).toBe(200);
    expect(storedRetry(harness, 'refund-1').resolvedAt).toEqual(now);
    expect(harness.enriched).toEqual([
      { transactionId: 'refund-1', walletId: 'wallet-1', providerId: 'provider-1' },
    ]);
    expect(harness.tracer.spans.map((span) => span.name)).toEqual([
      'usecase.resolve_pending_reference',
    ]);
  });

  it('publishes processed and balance events caused by the pending transaction', async () => {
    const harness = createHarness();
    seedBet(harness);
    seedRefund(harness);

    await useCaseFor(harness).execute(pendingRetry('refund-1'));

    const events = outboxEvents(harness);
    expect(events.map((event) => event.eventType)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    for (const event of events) {
      expect(event).toMatchObject({
        aggregateId: 'wallet-1',
        correlationId: 'corr-refund-1',
        causationId: 'refund-1',
        occurredAt: harness.clock.now().toISOString(),
      });
    }
    expect(new Set(events.map((event) => event.eventId)).size).toBe(2);
    expect(
      harness.metrics.counter('pending_reference_resolved_total', { outcome: 'PROCESSED' }),
    ).toBe(1);
    expect(
      harness.metrics.counter('wager_transactions_total', {
        status: 'PROCESSED',
        kind: 'REFUND',
        channel: 'scheduler',
        failure_code: 'none',
      }),
    ).toBe(1);
  });

  it('applies the reference that arrived during an outage on the last attempt', async () => {
    const harness = createHarness();
    seedBet(harness);
    seedRefund(harness);
    harness.clock.set(new Date(createdAt.getTime() + PENDING_TTL_MS + 60_000));

    const outcome = await useCaseFor(harness).execute(pendingRetry('refund-1'));

    expect(outcome).toBe('resolved');
    expect(storedTransaction(harness, 'refund-1').status).toBe(WagerTransactionStatus.Processed);
  });

  it('rejects by context before looking at the reference', async () => {
    const harness = createHarness();
    seedBet(harness);
    seedPending(harness, {
      id: 'refund-1',
      kind: WagerTransactionKind.Refund,
      playerId: 'player-2',
    });

    const outcome = await useCaseFor(harness).execute(pendingRetry('refund-1'));

    const transaction = storedTransaction(harness, 'refund-1');
    expect(outcome).toBe('resolved');
    expect(transaction.failureCode).toBe(FailureCode.PlayerWalletMismatch);
    expect(transaction.referenceTransactionId).toBeUndefined();
    expect(storedRecord(harness, 'refund-1').httpStatus).toBe(422);
  });

  it('wakes the dependents of a processed transaction', async () => {
    const harness = createHarness();
    seedBet(harness);
    seedRefund(harness);
    const later = new Date(createdAt.getTime() + 30_000);
    seedPending(
      harness,
      {
        id: 'rollback-1',
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: 'ext-refund-1',
      },
      { nextAttemptAt: later, lockedBy: undefined, lockedUntil: undefined },
    );

    await useCaseFor(harness).execute(pendingRetry('refund-1'));

    expect(storedRetry(harness, 'rollback-1').nextAttemptAt).toEqual(harness.clock.now());
  });

  it('flags a reversal after a processed win in the same round', async () => {
    const harness = createHarness();
    seedBet(harness);
    harness.uow.database.transactions.put(
      transactionState({
        id: 'win-1',
        kind: WagerTransactionKind.Win,
        referenceExternalTransactionId: 'ext-bet-1',
      }),
    );
    seedRefund(harness);

    await useCaseFor(harness).execute(pendingRetry('refund-1'));

    expect(harness.metrics.counter('wager_anomaly_total', { type: 'reversal_after_win' })).toBe(1);
    expect(harness.logger.entriesAt('warn')).toMatchObject([
      { fields: { transactionId: 'refund-1', walletId: 'wallet-1' } },
    ]);
  });

  it('hits the scheduler fault point after the resolution commits', async () => {
    const harness = createHarness();
    seedBet(harness);
    seedRefund(harness);
    harness.faults.arm('scheduler.after_commit');

    const error = await rejection(useCaseFor(harness).execute(pendingRetry('refund-1')));

    expect(error).toBeInstanceOf(InjectedFaultError);
    expect(harness.faults.hits).toEqual(['scheduler.after_commit']);
    expect(storedTransaction(harness, 'refund-1').status).toBe(WagerTransactionStatus.Processed);
    expect(storedRecord(harness, 'refund-1').httpStatus).toBe(200);
    expect(storedRetry(harness, 'refund-1').resolvedAt).toEqual(harness.clock.now());
    expect(
      harness.metrics.counter('pending_reference_resolved_total', { outcome: 'PROCESSED' }),
    ).toBe(0);
  });
});
