import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import type { ClockPort } from '@application/ports/clock.port';
import type { ContextEnricher } from '@application/ports/context-enricher';
import type { FaultInjectorPort } from '@application/ports/fault-injector.port';
import type { IdGeneratorPort } from '@application/ports/id-generator.port';
import type { LoggerPort } from '@application/ports/logger.port';
import type { MetricsPort } from '@application/ports/metrics.port';
import type { PendingReferenceRetry } from '@application/ports/repositories/pending-reference-repository.port';
import type { TracerPort } from '@application/ports/tracer.port';
import type { Repositories, UnitOfWorkPort } from '@application/ports/unit-of-work.port';
import type { AnomalyDetector } from '@application/services/anomaly-detector';
import type { OutcomeMapper } from '@application/services/outcome-mapper';
import type { EventContext, IntegrationEvent } from '@domain/messaging/integration-event';
import { OutboxMessage } from '@domain/messaging/outbox-message';
import { WagerTransactionProcessed } from '@domain/messaging/events/wager-transaction-processed.event';
import { WagerTransactionRejected } from '@domain/messaging/events/wager-transaction-rejected.event';
import { WalletBalanceChanged } from '@domain/messaging/events/wallet-balance-changed.event';
import { FailureCode } from '@domain/shared/failure-code';
import { InvalidTransactionStateError } from '@domain/wagering/errors/invalid-transaction-state.error';
import { decideReference, type ReferenceDecision } from '@domain/wagering/reference-policy';
import type { ApplyResult, TransactionApplier } from '@domain/wagering/transaction-applier';
import type { WagerTransaction } from '@domain/wagering/wager-transaction';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '@domain/wagering/wager-transaction-status';
import { HouseAccountPurpose } from '@domain/wallet/house-account';
import type { Wallet } from '@domain/wallet/wallet';

export type ResolvePendingReferenceOutcome =
  'resolved' | 'waiting' | 'skipped' | 'already-resolved';

export interface ResolvePendingReferenceConfig {
  instanceId: string;
  pendingLeaseMs: number;
}

const SECOND_MS = 1_000;
export const MAX_PENDING_RETRY_DELAY_MS = 60_000;

export const waitRetryDelayMs = (attempts: number): number =>
  Math.min(2 ** (attempts - 1) * SECOND_MS, MAX_PENDING_RETRY_DELAY_MS);

export const pendingEventContext = (
  transaction: WagerTransaction,
  eventId: string,
  now: Date,
): EventContext => ({
  eventId,
  correlationId: transaction.correlationId,
  causationId: transaction.id,
  occurredAt: now,
});

type ResolvedOutcome = 'PROCESSED' | 'REJECTED';

type Resolution =
  | { type: 'waiting' | 'skipped' | 'already-resolved' }
  | {
      type: 'resolved';
      transaction: WagerTransaction;
      walletId: string;
      outcome: ResolvedOutcome;
      anomaly: boolean;
    };

interface ResolutionInput {
  repos: Repositories;
  wallet: Wallet;
  transaction: WagerTransaction;
  reference: WagerTransaction | undefined;
  result: ApplyResult;
  now: Date;
}

interface ReferenceLookup {
  reference: WagerTransaction | undefined;
  decision: ReferenceDecision;
}

const deterministic = (): TechnicalError =>
  new TechnicalError(ErrorClass.Deterministic, 'deterministic');

const resolvedOutcomeOf = (result: ApplyResult): ResolvedOutcome => {
  if (result.outcome === 'PENDING_REFERENCE') {
    throw new InvalidTransactionStateError('pending reference resolution cannot stay pending');
  }
  return result.outcome;
};

const isReversal = (transaction: WagerTransaction): boolean =>
  transaction.kind === WagerTransactionKind.Refund ||
  transaction.kind === WagerTransactionKind.Rollback;

export interface ResolvePendingReferenceDependencies {
  uow: UnitOfWorkPort;
  clock: ClockPort;
  ids: IdGeneratorPort;
  faults: FaultInjectorPort;
  logger: LoggerPort;
  metrics: MetricsPort;
  tracer: TracerPort;
  enrich: ContextEnricher;
  applier: TransactionApplier;
  outcomeMapper: OutcomeMapper;
  anomalyDetector: AnomalyDetector;
}

export class ResolvePendingReferenceUseCase {
  constructor(
    private readonly deps: ResolvePendingReferenceDependencies,
    private readonly config: ResolvePendingReferenceConfig,
  ) {}

  execute(retry: PendingReferenceRetry): Promise<ResolvePendingReferenceOutcome> {
    return this.deps.tracer.inSpan(
      'usecase.resolve_pending_reference',
      { transactionId: retry.transactionId },
      () => this.resolve(retry),
    );
  }

  private async resolve(retry: PendingReferenceRetry): Promise<ResolvePendingReferenceOutcome> {
    const renewed = await this.deps.uow.run('short', (repos) =>
      repos.pendingReferences.renewLease(
        retry.transactionId,
        this.config.instanceId,
        this.config.pendingLeaseMs,
      ),
    );
    if (!renewed) {
      return 'skipped';
    }
    const pending = await this.deps.uow.read((repos) =>
      repos.transactions.findById(retry.transactionId),
    );
    if (pending === undefined) {
      throw deterministic();
    }
    this.deps.enrich({
      transactionId: pending.id,
      walletId: pending.walletId,
      providerId: pending.providerId,
    });
    const resolution = await this.deps.uow.run('write', (repos) =>
      this.resolveLocked(repos, retry, pending.walletId),
    );
    if (resolution.type !== 'resolved') {
      return resolution.type;
    }
    this.deps.faults.hit('scheduler.after_commit');
    this.emitResolved(resolution);
    return 'resolved';
  }

  private async resolveLocked(
    repos: Repositories,
    retry: PendingReferenceRetry,
    walletId: string,
  ): Promise<Resolution> {
    const locked = await repos.wallets.lockById(walletId);
    if (locked === undefined) {
      throw deterministic();
    }
    const { wallet } = locked;
    const transaction = await repos.transactions.findById(retry.transactionId, { refresh: true });
    const now = this.deps.clock.now();
    if (transaction?.status !== WagerTransactionStatus.PendingReference) {
      await repos.pendingReferences.markResolved(retry.transactionId, now);
      return { type: 'already-resolved' };
    }
    const contextResult = this.deps.applier.checkContext({ wallet, transaction, now });
    if (contextResult !== undefined) {
      return this.persist({
        repos,
        wallet,
        transaction,
        reference: undefined,
        result: contextResult,
        now,
      });
    }
    const { reference, decision } = await this.lookupReference(repos, transaction, retry, now);
    if (decision.type === 'WAIT') {
      const attempts = retry.attempts + 1;
      const scheduled = await repos.pendingReferences.scheduleNext({
        transactionId: retry.transactionId,
        instanceId: this.config.instanceId,
        nextAttemptAt: new Date(now.getTime() + waitRetryDelayMs(attempts)),
        attempts,
        consecutiveErrors: 0,
      });
      return { type: scheduled ? 'waiting' : 'skipped' };
    }
    const gaming = await repos.houseAccounts.findByCurrencyAndPurpose(
      wallet.currency,
      HouseAccountPurpose.Gaming,
    );
    if (gaming === undefined) {
      throw deterministic();
    }
    const result = this.deps.applier.apply({
      wallet,
      transaction,
      reference,
      decision,
      gamingAccountId: gaming.id,
      walletEntryId: this.deps.ids.next(),
      houseEntryId: this.deps.ids.next(),
      now,
    });
    return this.persist({ repos, wallet, transaction, reference, result, now });
  }

  private async lookupReference(
    repos: Repositories,
    transaction: WagerTransaction,
    retry: PendingReferenceRetry,
    now: Date,
  ): Promise<ReferenceLookup> {
    const { referenceExternalTransactionId } = transaction;
    const reference =
      referenceExternalTransactionId === undefined
        ? undefined
        : await repos.transactions.findByProviderAndExternalId(
            transaction.providerId,
            referenceExternalTransactionId,
            { refresh: true },
          );
    const referenceAlreadyReversed =
      reference === undefined ? false : await repos.transactions.isReversed(reference.id);
    const decision = decideReference({ transaction, reference, referenceAlreadyReversed });
    if (decision.type !== 'WAIT' || now.getTime() < retry.deadlineAt.getTime()) {
      return { reference, decision };
    }
    return {
      reference,
      decision: {
        type: 'REJECT',
        failureCode:
          reference === undefined
            ? FailureCode.ReferenceNotFound
            : FailureCode.ReferenceNotProcessed,
        referenceTransactionId: reference?.id,
      },
    };
  }

  private async persist(input: ResolutionInput): Promise<Resolution> {
    const { repos, wallet, transaction, result, now } = input;
    const outcome = resolvedOutcomeOf(result);
    repos.transactions.update(transaction);
    const posting = result.outcome === 'PROCESSED' ? result.posting : undefined;
    if (posting !== undefined) {
      repos.ledger.insertPosting(posting);
      repos.wallets.update(wallet);
    }
    for (const event of this.eventsFor(input, outcome)) {
      repos.outbox.enqueue(OutboxMessage.enqueue(event));
    }
    const record = await repos.idempotency.find(
      transaction.providerId,
      transaction.idempotencyKey,
      {
        refresh: true,
      },
    );
    if (record === undefined) {
      throw deterministic();
    }
    record.resolve({
      httpStatus: outcome === 'PROCESSED' ? 200 : 422,
      responseBody: this.deps.outcomeMapper.toBody(transaction, { replay: false }),
      at: now,
    });
    repos.idempotency.update(record);
    await repos.pendingReferences.markResolved(transaction.id, now);
    let anomaly = false;
    if (outcome === 'PROCESSED') {
      await repos.pendingReferences.wakeDependents(
        transaction.providerId,
        transaction.externalTransactionId,
      );
      anomaly = await this.detectAnomaly(input);
    }
    await repos.flush();
    if (posting !== undefined) {
      await repos.wallets.assertPersistedVersion(wallet);
    }
    return { type: 'resolved', transaction, walletId: wallet.id, outcome, anomaly };
  }

  private eventsFor(input: ResolutionInput, outcome: ResolvedOutcome): IntegrationEvent<unknown>[] {
    const { wallet, transaction, result, now } = input;
    const context = (): EventContext => pendingEventContext(transaction, this.deps.ids.next(), now);
    if (outcome === 'REJECTED') {
      return [WagerTransactionRejected.from(transaction, wallet, context())];
    }
    const processed = WagerTransactionProcessed.from(transaction, wallet, context());
    if (result.outcome !== 'PROCESSED' || result.posting === undefined) {
      return [processed];
    }
    return [processed, WalletBalanceChanged.from(wallet, result.posting.walletEntry, context())];
  }

  private async detectAnomaly(input: ResolutionInput): Promise<boolean> {
    const { repos, wallet, transaction, reference } = input;
    if (!isReversal(transaction) || reference?.kind !== WagerTransactionKind.Bet) {
      return false;
    }
    const hasProcessedWinInRound = await repos.transactions.hasProcessedWinInRound(
      wallet.id,
      transaction.roundId,
    );
    return this.deps.anomalyDetector.isReversalAfterWin({
      transaction,
      reference,
      hasProcessedWinInRound,
    });
  }

  private emitResolved(resolution: Extract<Resolution, { type: 'resolved' }>): void {
    const { transaction, outcome } = resolution;
    this.deps.metrics.pendingResolved(outcome);
    this.deps.metrics.transactionRecorded({
      status: outcome,
      kind: transaction.kind,
      channel: 'scheduler',
      failureCode: transaction.failureCode ?? 'none',
    });
    if (resolution.anomaly) {
      this.deps.metrics.anomaly('reversal_after_win');
      this.deps.logger.warn('reversal after win detected', {
        correlationId: transaction.correlationId,
        transactionId: transaction.id,
        walletId: resolution.walletId,
        providerId: transaction.providerId,
      });
    }
  }
}
