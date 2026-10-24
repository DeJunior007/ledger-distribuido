import { ErrorClass, TechnicalError, classifyError } from '@application/errors/error-class';
import type { ClockPort } from '@application/ports/clock.port';
import type { ContextEnricher } from '@application/ports/context-enricher';
import type { IdGeneratorPort } from '@application/ports/id-generator.port';
import type { LoggerPort } from '@application/ports/logger.port';
import type { MetricsPort } from '@application/ports/metrics.port';
import type { PendingReferenceRetry } from '@application/ports/repositories/pending-reference-repository.port';
import type { TracerPort } from '@application/ports/tracer.port';
import type { Repositories, UnitOfWorkPort } from '@application/ports/unit-of-work.port';
import type { OutcomeMapper } from '@application/services/outcome-mapper';
import { WagerTransactionFailed } from '@domain/messaging/events/wager-transaction-failed.event';
import { OutboxMessage } from '@domain/messaging/outbox-message';
import { FailureCode } from '@domain/shared/failure-code';
import type { WagerTransaction } from '@domain/wagering/wager-transaction';
import { WagerTransactionStatus } from '@domain/wagering/wager-transaction-status';
import {
  MAX_PENDING_RETRY_DELAY_MS,
  pendingEventContext,
} from './resolve-pending-reference.use-case';

export type FailPendingReferenceOutcome = 'failed' | 'already-resolved' | 'rescheduled';

export interface FailPendingReferenceConfig {
  instanceId: string;
}

const DETERMINISTIC_BASE_DELAY_MS = 5_000;

export const deterministicRetryDelayMs = (consecutiveErrors: number): number =>
  Math.min(2 ** consecutiveErrors * DETERMINISTIC_BASE_DELAY_MS, MAX_PENDING_RETRY_DELAY_MS);

type Failure = { type: 'already-resolved' } | { type: 'failed'; transaction: WagerTransaction };

export interface FailPendingReferenceDependencies {
  uow: UnitOfWorkPort;
  clock: ClockPort;
  ids: IdGeneratorPort;
  logger: LoggerPort;
  metrics: MetricsPort;
  tracer: TracerPort;
  enrich: ContextEnricher;
  outcomeMapper: OutcomeMapper;
}

export class FailPendingReferenceUseCase {
  constructor(
    private readonly deps: FailPendingReferenceDependencies,
    private readonly config: FailPendingReferenceConfig,
  ) {}

  execute(retry: PendingReferenceRetry): Promise<FailPendingReferenceOutcome> {
    return this.deps.tracer.inSpan(
      'usecase.fail_pending_reference',
      { transactionId: retry.transactionId },
      () => this.failOrReschedule(retry),
    );
  }

  private async failOrReschedule(
    retry: PendingReferenceRetry,
  ): Promise<FailPendingReferenceOutcome> {
    let failure: Failure;
    try {
      failure = await this.fail(retry);
    } catch (error) {
      await this.reschedule(retry, error);
      return 'rescheduled';
    }
    if (failure.type === 'already-resolved') {
      return 'already-resolved';
    }
    const { transaction } = failure;
    this.deps.metrics.pendingResolved('FAILED');
    this.deps.metrics.transactionRecorded({
      status: 'FAILED',
      kind: transaction.kind,
      channel: 'scheduler',
      failureCode: FailureCode.ProcessingFailed,
    });
    return 'failed';
  }

  private async fail(retry: PendingReferenceRetry): Promise<Failure> {
    const pending = await this.deps.uow.read((repos) =>
      repos.transactions.findById(retry.transactionId),
    );
    if (pending === undefined) {
      await this.deps.uow.run('short', (repos) =>
        repos.pendingReferences.markResolved(retry.transactionId, this.deps.clock.now()),
      );
      return { type: 'already-resolved' };
    }
    this.deps.enrich({
      transactionId: pending.id,
      walletId: pending.walletId,
      providerId: pending.providerId,
    });
    return this.deps.uow.run('write', (repos) =>
      this.failLocked(repos, retry.transactionId, pending.walletId),
    );
  }

  private async failLocked(
    repos: Repositories,
    transactionId: string,
    walletId: string,
  ): Promise<Failure> {
    const locked = await repos.wallets.lockById(walletId);
    if (locked === undefined) {
      throw new TechnicalError(ErrorClass.Deterministic, 'deterministic');
    }
    const { wallet } = locked;
    const transaction = await repos.transactions.findById(transactionId, { refresh: true });
    const now = this.deps.clock.now();
    if (transaction?.status !== WagerTransactionStatus.PendingReference) {
      await repos.pendingReferences.markResolved(transactionId, now);
      return { type: 'already-resolved' };
    }
    transaction.fail({ balanceSnapshot: wallet.balance, at: now });
    repos.transactions.update(transaction);
    repos.outbox.enqueue(
      OutboxMessage.enqueue(
        WagerTransactionFailed.from(
          transaction,
          wallet,
          pendingEventContext(transaction, this.deps.ids.next(), now),
        ),
      ),
    );
    const record = await repos.idempotency.find(
      transaction.providerId,
      transaction.idempotencyKey,
      {
        refresh: true,
      },
    );
    if (record === undefined) {
      throw new TechnicalError(ErrorClass.Deterministic, 'deterministic');
    }
    record.resolve({
      httpStatus: 500,
      responseBody: this.deps.outcomeMapper.toBody(transaction, { replay: false }),
      at: now,
    });
    repos.idempotency.update(record);
    await repos.pendingReferences.markResolved(transaction.id, now);
    await repos.flush();
    return { type: 'failed', transaction };
  }

  private async reschedule(retry: PendingReferenceRetry, error: unknown): Promise<void> {
    this.deps.logger.error('pending reference failure path failed', {
      transactionId: retry.transactionId,
      errorClass: classifyError(error),
      ...(error instanceof TechnicalError ? { reason: error.reason } : {}),
    });
    this.deps.metrics.pendingFailedPathError();
    const consecutiveErrors = retry.consecutiveErrors + 1;
    await this.deps.uow.run('short', (repos) =>
      repos.pendingReferences.scheduleNext({
        transactionId: retry.transactionId,
        instanceId: this.config.instanceId,
        nextAttemptAt: new Date(
          this.deps.clock.now().getTime() + deterministicRetryDelayMs(consecutiveErrors),
        ),
        attempts: retry.attempts,
        consecutiveErrors,
      }),
    );
  }
}
