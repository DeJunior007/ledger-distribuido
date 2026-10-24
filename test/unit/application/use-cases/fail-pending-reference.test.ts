import { describe, expect, it } from 'bun:test';
import {
  FailPendingReferenceUseCase,
  deterministicRetryDelayMs,
} from '@application/use-cases/fail-pending-reference.use-case';
import { FailureCode } from '@domain/shared/failure-code';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '@domain/wagering/wager-transaction-status';
import {
  INSTANCE_ID,
  brl,
  createHarness,
  outboxEvents,
  pendingRetry,
  seedPending,
  storedRecord,
  storedRetry,
  storedTransaction,
  transactionState,
  type PendingHarness,
} from './pending-reference.fixtures';

const useCaseFor = (harness: PendingHarness): FailPendingReferenceUseCase =>
  new FailPendingReferenceUseCase(
    {
      uow: harness.uow,
      clock: harness.clock,
      ids: harness.ids,
      logger: harness.logger,
      metrics: harness.metrics,
      tracer: harness.tracer,
      enrich: (fields) => {
        harness.enriched.push({ ...fields });
      },
      outcomeMapper: harness.outcomeMapper,
    },
    { instanceId: INSTANCE_ID },
  );

const seedRefund = (harness: PendingHarness): void => {
  seedPending(
    harness,
    { id: 'refund-1', kind: WagerTransactionKind.Refund },
    { attempts: 4, consecutiveErrors: 1 },
  );
};

describe('FailPendingReferenceUseCase', () => {
  it('fails the pending transaction, publishes the event and resolves the record with 500', async () => {
    const harness = createHarness();
    seedRefund(harness);

    const outcome = await useCaseFor(harness).execute(
      pendingRetry('refund-1', { attempts: 4, consecutiveErrors: 1 }),
    );

    const now = harness.clock.now();
    const transaction = storedTransaction(harness, 'refund-1');
    expect(outcome).toBe('failed');
    expect(transaction.status).toBe(WagerTransactionStatus.Failed);
    expect(transaction.failureCode).toBe(FailureCode.ProcessingFailed);
    expect(transaction.balanceSnapshot).toEqual(brl('100.00'));
    const record = storedRecord(harness, 'refund-1');
    expect(record.httpStatus).toBe(500);
    expect(record.responseBody).toMatchObject({
      transactionId: 'refund-1',
      status: 'FAILED',
      failureCode: 'PROCESSING_FAILED',
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(storedRetry(harness, 'refund-1').resolvedAt).toEqual(now);
    expect(outboxEvents(harness)).toMatchObject([
      {
        eventType: 'WagerTransactionFailed',
        aggregateId: 'wallet-1',
        correlationId: 'corr-refund-1',
        causationId: 'refund-1',
        occurredAt: now.toISOString(),
        data: { transactionId: 'refund-1', failureCode: 'PROCESSING_FAILED', walletVersion: 2 },
      },
    ]);
    expect(harness.uow.database.wallets.get('wallet-1')?.version).toBe(2);
    expect(harness.metrics.counter('pending_reference_resolved_total', { outcome: 'FAILED' })).toBe(
      1,
    );
    expect(
      harness.metrics.counter('wager_transactions_total', {
        status: 'FAILED',
        kind: 'REFUND',
        channel: 'scheduler',
        failure_code: 'PROCESSING_FAILED',
      }),
    ).toBe(1);
    expect(harness.tracer.spans.map((span) => span.name)).toEqual([
      'usecase.fail_pending_reference',
    ]);
  });

  it('only marks the retry resolved when the transaction is already terminal', async () => {
    const harness = createHarness();
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
    expect(storedTransaction(harness, 'refund-1').status).toBe(WagerTransactionStatus.Processed);
    expect(storedRecord(harness, 'refund-1').httpStatus).toBe(202);
    expect(storedRetry(harness, 'refund-1').resolvedAt).toEqual(harness.clock.now());
    expect(outboxEvents(harness)).toHaveLength(0);
  });

  it('keeps the pending alive and reschedules it when the failure path breaks', async () => {
    const broken = createHarness();
    broken.uow.database.transactions.put(
      transactionState({
        id: 'refund-1',
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'ext-bet-1',
        status: WagerTransactionStatus.PendingReference,
        processedAt: undefined,
      }),
    );
    broken.uow.database.pendingReferences.put(
      pendingRetry('refund-1', { attempts: 4, consecutiveErrors: 1 }),
    );
    const outcome = await useCaseFor(broken).execute(
      pendingRetry('refund-1', { attempts: 4, consecutiveErrors: 1 }),
    );

    const retry = storedRetry(broken, 'refund-1');
    expect(outcome).toBe('rescheduled');
    expect(storedTransaction(broken, 'refund-1').status).toBe(
      WagerTransactionStatus.PendingReference,
    );
    expect(outboxEvents(broken)).toHaveLength(0);
    expect(retry.resolvedAt).toBeUndefined();
    expect(retry.attempts).toBe(4);
    expect(retry.consecutiveErrors).toBe(2);
    expect(retry.nextAttemptAt).toEqual(new Date(broken.clock.now().getTime() + 20_000));
    expect(retry.lockedBy).toBeUndefined();
    expect(broken.metrics.counter('pending_reference_failed_path_errors_total')).toBe(1);
    expect(broken.logger.entriesAt('error')).toMatchObject([
      { fields: { transactionId: 'refund-1', errorClass: 'DETERMINISTIC' } },
    ]);
  });

  it('caps the deterministic wait at sixty seconds', () => {
    expect([0, 1, 2, 3, 4, 10].map(deterministicRetryDelayMs)).toEqual([
      5_000, 10_000, 20_000, 40_000, 60_000, 60_000,
    ]);
  });
});
