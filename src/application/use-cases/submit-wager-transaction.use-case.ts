import type { TransactionResultBody } from '@domain/idempotency/response-bodies';
import { WagerTransactionPendingReference } from '@domain/messaging/events/wager-transaction-pending-reference.event';
import { WagerTransactionProcessed } from '@domain/messaging/events/wager-transaction-processed.event';
import { WagerTransactionRejected } from '@domain/messaging/events/wager-transaction-rejected.event';
import { WalletBalanceChanged } from '@domain/messaging/events/wallet-balance-changed.event';
import type { InboxMessage } from '@domain/messaging/inbox-message';
import type { EventContext } from '@domain/messaging/integration-event';
import { OutboxMessage } from '@domain/messaging/outbox-message';
import type { FailureCode } from '@domain/shared/failure-code';
import { Money } from '@domain/shared/money';
import { decideReference, type ReferenceDecision } from '@domain/wagering/reference-policy';
import type { ApplyResult, TransactionApplier } from '@domain/wagering/transaction-applier';
import { WagerTransaction } from '@domain/wagering/wager-transaction';
import { HouseAccountPurpose } from '@domain/wallet/house-account';
import type { LedgerPosting } from '@domain/wallet/ledger-posting';
import type { Wallet } from '@domain/wallet/wallet';
import type {
  SubmitResult,
  SubmitWagerTransactionCommand,
} from '@application/commands/submit-wager-transaction.command';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import { ProviderIdentityMismatchError } from '@application/errors/provider-identity-mismatch.error';
import { RollbackSignal } from '@application/errors/rollback-signal';
import type { ClockPort } from '@application/ports/clock.port';
import type { ContextEnricher } from '@application/ports/context-enricher';
import type { FaultInjectorPort } from '@application/ports/fault-injector.port';
import type { HasherPort } from '@application/ports/hasher.port';
import type { IdGeneratorPort } from '@application/ports/id-generator.port';
import type { LoggerPort } from '@application/ports/logger.port';
import type { MetricsPort } from '@application/ports/metrics.port';
import type { LockedWallet } from '@application/ports/repositories/wallet-repository.port';
import type { TracerPort } from '@application/ports/tracer.port';
import type { Repositories, UnitOfWorkPort } from '@application/ports/unit-of-work.port';
import type { AnomalyDetector } from '@application/services/anomaly-detector';
import type { OutcomeMapper } from '@application/services/outcome-mapper';
import { computePayloadHash } from '@application/services/payload-hash';
import {
  SubmissionFastPath,
  externalTransactionIdConflictProblem,
  idempotencyKeyConflict,
  markInboxProcessed,
  receiveInbox,
  replayOf,
  storeRecord,
} from '@application/services/submission-fast-path';

const MAX_SUBMISSION_ATTEMPTS = 2;
const PENDING_FIRST_RETRY_DELAY_MS = 1000;

const OUTCOME_HTTP_STATUS: Readonly<Record<ApplyResult['outcome'], 200 | 202 | 422>> = {
  PROCESSED: 200,
  PENDING_REFERENCE: 202,
  REJECTED: 422,
};

const isRace = (error: unknown): error is TechnicalError =>
  error instanceof TechnicalError && error.errorClass === ErrorClass.Race;

export interface SubmitWagerTransactionDependencies {
  uow: UnitOfWorkPort;
  clock: ClockPort;
  ids: IdGeneratorPort;
  hasher: HasherPort;
  faults: FaultInjectorPort;
  logger: LoggerPort;
  metrics: MetricsPort;
  tracer: TracerPort;
  enrich: ContextEnricher;
  applier: TransactionApplier;
  outcomeMapper: OutcomeMapper;
  anomalyDetector: AnomalyDetector;
}

export interface SubmitWagerTransactionConfig {
  pendingTtlMs: number;
}

interface SubmissionAttempt {
  readonly command: SubmitWagerTransactionCommand;
  readonly payloadHash: string;
  readonly startedAt: Date;
  readonly afterCommit: (() => void)[];
  rollback: RollbackSignal<SubmitResult> | undefined;
}

interface GuardedSubmission {
  readonly repos: Repositories;
  readonly attempt: SubmissionAttempt;
  readonly locked: LockedWallet;
  readonly inbox: InboxMessage | undefined;
  readonly now: Date;
}

interface ResolvedReference {
  readonly reference: WagerTransaction | undefined;
  readonly decision: ReferenceDecision;
}

interface AppliedSubmission {
  readonly transaction: WagerTransaction;
  readonly wallet: Wallet;
  readonly result: ApplyResult;
  readonly posting: LedgerPosting | undefined;
  readonly deadlineAt: Date;
}

export class SubmitWagerTransactionUseCase {
  private readonly fastPath: SubmissionFastPath;

  constructor(
    private readonly deps: SubmitWagerTransactionDependencies,
    private readonly config: SubmitWagerTransactionConfig,
  ) {
    this.fastPath = new SubmissionFastPath(deps.uow, deps.metrics);
  }

  execute(command: SubmitWagerTransactionCommand): Promise<SubmitResult> {
    return this.deps.tracer.inSpan(
      'usecase.submit_wager_transaction',
      { channel: command.channel, providerId: command.providerId, walletId: command.walletId },
      () => this.submit(command),
    );
  }

  private async submit(command: SubmitWagerTransactionCommand): Promise<SubmitResult> {
    this.deps.enrich({ walletId: command.walletId, providerId: command.providerId });
    if (
      command.identity.kind === 'provider' &&
      command.identity.providerId !== command.providerId
    ) {
      throw new ProviderIdentityMismatchError();
    }
    const payloadHash = computePayloadHash(command, this.deps.hasher);
    const startedAt = this.deps.clock.now();
    return this.submitAttempt(command, payloadHash, startedAt, 1);
  }

  private async submitAttempt(
    command: SubmitWagerTransactionCommand,
    payloadHash: string,
    startedAt: Date,
    attemptNumber: number,
  ): Promise<SubmitResult> {
    const decision = await this.fastPath.check(command, payloadHash);
    if (decision.kind === 'resolved') {
      return decision.result;
    }
    try {
      return await this.runGuarded({
        command,
        payloadHash,
        startedAt,
        afterCommit: [],
        rollback: undefined,
      });
    } catch (error) {
      if (!isRace(error)) {
        throw error;
      }
      if (attemptNumber >= MAX_SUBMISSION_ATTEMPTS) {
        throw new TechnicalError(ErrorClass.Transient, 'race_repeated', { cause: error });
      }
      this.deps.metrics.lockConflict('unique_retry');
      return this.submitAttempt(command, payloadHash, startedAt, attemptNumber + 1);
    }
  }

  private async runGuarded(attempt: SubmissionAttempt): Promise<SubmitResult> {
    try {
      const result = await this.deps.uow.run('write', (repos) => this.guard(repos, attempt));
      this.emitAfterCommit(attempt);
      return result;
    } catch (error) {
      if (attempt.rollback !== undefined && error === attempt.rollback) {
        this.emitAfterCommit(attempt);
        return attempt.rollback.result;
      }
      throw error;
    }
  }

  private async guard(repos: Repositories, attempt: SubmissionAttempt): Promise<SubmitResult> {
    const { command, payloadHash } = attempt;
    const now = this.deps.clock.now();
    const inbox = await receiveInbox(repos, command, now);
    const alreadyUsed = await repos.transactions.findByProviderAndExternalId(
      command.providerId,
      command.externalTransactionId,
    );
    if (alreadyUsed !== undefined) {
      return this.recordExternalIdConflict(repos, attempt, alreadyUsed, inbox, now);
    }
    const locked = await repos.wallets.lockById(command.walletId);
    if (locked === undefined) {
      return this.recordWalletNotFound(repos, attempt, inbox, now);
    }
    this.noteLockAcquired(attempt, locked);
    const record = await repos.idempotency.find(command.providerId, command.idempotencyKey, {
      refresh: true,
    });
    if (record !== undefined) {
      if (!record.matches(payloadHash)) {
        attempt.rollback = new RollbackSignal(idempotencyKeyConflict());
        attempt.afterCommit.push(() => {
          this.deps.metrics.idempotencyConflict(command.channel, 'idempotency_key');
        });
        throw attempt.rollback;
      }
      await markInboxProcessed(repos, inbox, now);
      attempt.afterCommit.push(() => {
        this.deps.metrics.idempotencyReplay(command.channel);
      });
      return replayOf(record);
    }
    const conflicting = await repos.transactions.findByProviderAndExternalId(
      command.providerId,
      command.externalTransactionId,
      { refresh: true },
    );
    if (conflicting !== undefined) {
      return this.recordExternalIdConflict(repos, attempt, conflicting, inbox, now);
    }
    return this.applyAndPersist({ repos, attempt, locked, inbox, now });
  }

  private async applyAndPersist(guarded: GuardedSubmission): Promise<SubmitResult> {
    const { repos, attempt, inbox, now } = guarded;
    const { wallet } = guarded.locked;
    const transaction = this.createTransaction(attempt, now);
    this.deps.enrich({ transactionId: transaction.id });
    const contextResult = this.deps.applier.checkContext({ wallet, transaction, now });
    const resolved =
      contextResult === undefined ? await this.resolveReference(repos, transaction) : undefined;
    const gaming = await repos.houseAccounts.findByCurrencyAndPurpose(
      wallet.currency,
      HouseAccountPurpose.Gaming,
    );
    if (gaming === undefined) {
      throw new TechnicalError(ErrorClass.Deterministic, 'deterministic');
    }
    const result =
      contextResult ??
      this.deps.applier.apply({
        wallet,
        transaction,
        reference: resolved?.reference,
        decision: resolved?.decision ?? { type: 'APPLY', referenceTransactionId: undefined },
        gamingAccountId: gaming.id,
        walletEntryId: this.deps.ids.next(),
        houseEntryId: this.deps.ids.next(),
        now,
      });
    const applied: AppliedSubmission = {
      transaction,
      wallet,
      result,
      posting: result.outcome === 'PROCESSED' ? result.posting : undefined,
      deadlineAt: new Date(transaction.createdAt.getTime() + this.config.pendingTtlMs),
    };
    const outcome = await this.persistOutcome(repos, attempt, applied, inbox, now);
    if (result.outcome === 'PROCESSED') {
      await repos.pendingReferences.wakeDependents(
        transaction.providerId,
        transaction.externalTransactionId,
      );
      await this.detectReversalAfterWin(repos, attempt, transaction, resolved?.reference);
    }
    await repos.flush();
    if (applied.posting !== undefined) {
      await repos.wallets.assertPersistedVersion(wallet);
    }
    this.deps.faults.hit(
      attempt.command.channel === 'http' ? 'api.before_commit' : 'consumer.before_commit',
    );
    return outcome;
  }

  private createTransaction(attempt: SubmissionAttempt, now: Date): WagerTransaction {
    const { command, payloadHash } = attempt;
    return WagerTransaction.create({
      id: this.deps.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: Money.from(command.money),
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      correlationId: command.correlationId,
      now,
    });
  }

  private async resolveReference(
    repos: Repositories,
    transaction: WagerTransaction,
  ): Promise<ResolvedReference> {
    const { referenceExternalTransactionId } = transaction;
    if (referenceExternalTransactionId === undefined) {
      return {
        reference: undefined,
        decision: { type: 'APPLY', referenceTransactionId: undefined },
      };
    }
    const reference = await repos.transactions.findByProviderAndExternalId(
      transaction.providerId,
      referenceExternalTransactionId,
      { refresh: true },
    );
    const referenceAlreadyReversed =
      reference === undefined ? false : await repos.transactions.isReversed(reference.id);
    return {
      reference,
      decision: decideReference({ transaction, reference, referenceAlreadyReversed }),
    };
  }

  private async persistOutcome(
    repos: Repositories,
    attempt: SubmissionAttempt,
    applied: AppliedSubmission,
    inbox: InboxMessage | undefined,
    now: Date,
  ): Promise<SubmitResult> {
    const { transaction, wallet, result, posting, deadlineAt } = applied;
    repos.transactions.insert(transaction);
    if (posting !== undefined) {
      repos.ledger.insertPosting(posting);
      repos.wallets.update(wallet);
    }
    if (result.outcome === 'PENDING_REFERENCE') {
      repos.pendingReferences.insert({
        transactionId: transaction.id,
        attempts: 0,
        consecutiveErrors: 0,
        nextAttemptAt: new Date(now.getTime() + PENDING_FIRST_RETRY_DELAY_MS),
        deadlineAt,
        createdAt: now,
        lockedUntil: undefined,
        lockedBy: undefined,
        resolvedAt: undefined,
      });
    }
    this.enqueueEvents(repos, attempt.command, applied, now);
    const httpStatus = OUTCOME_HTTP_STATUS[result.outcome];
    const body = this.deps.outcomeMapper.toBody(transaction, { replay: false });
    await storeRecord(
      repos,
      attempt,
      { httpStatus, body, transactionId: transaction.id },
      inbox,
      now,
    );
    this.noteNewOutcome(attempt, body.status, transaction.failureCode);
    return { kind: 'outcome', httpStatus, body, replay: false };
  }

  private enqueueEvents(
    repos: Repositories,
    command: SubmitWagerTransactionCommand,
    applied: AppliedSubmission,
    now: Date,
  ): void {
    const { transaction, wallet, result, posting, deadlineAt } = applied;
    switch (result.outcome) {
      case 'PROCESSED':
        repos.outbox.enqueue(
          OutboxMessage.enqueue(
            WagerTransactionProcessed.from(transaction, wallet, this.eventContext(command, now)),
          ),
        );
        if (posting !== undefined) {
          repos.outbox.enqueue(
            OutboxMessage.enqueue(
              WalletBalanceChanged.from(
                wallet,
                posting.walletEntry,
                this.eventContext(command, now),
              ),
            ),
          );
        }
        return;
      case 'REJECTED':
        repos.outbox.enqueue(
          OutboxMessage.enqueue(
            WagerTransactionRejected.from(transaction, wallet, this.eventContext(command, now)),
          ),
        );
        return;
      case 'PENDING_REFERENCE':
        repos.outbox.enqueue(
          OutboxMessage.enqueue(
            WagerTransactionPendingReference.from(
              transaction,
              wallet,
              deadlineAt,
              this.eventContext(command, now),
            ),
          ),
        );
        return;
    }
  }

  private eventContext(command: SubmitWagerTransactionCommand, now: Date): EventContext {
    return {
      eventId: this.deps.ids.next(),
      correlationId: command.correlationId,
      causationId: command.causationId,
      occurredAt: now,
    };
  }

  private async detectReversalAfterWin(
    repos: Repositories,
    attempt: SubmissionAttempt,
    transaction: WagerTransaction,
    reference: WagerTransaction | undefined,
  ): Promise<void> {
    const { anomalyDetector } = this.deps;
    if (
      !anomalyDetector.isReversalAfterWin({ transaction, reference, hasProcessedWinInRound: true })
    ) {
      return;
    }
    const hasProcessedWinInRound = await repos.transactions.hasProcessedWinInRound(
      transaction.walletId,
      transaction.roundId,
    );
    if (!anomalyDetector.isReversalAfterWin({ transaction, reference, hasProcessedWinInRound })) {
      return;
    }
    attempt.afterCommit.push(() => {
      this.deps.metrics.anomaly('reversal_after_win');
      this.deps.logger.warn('reversal after win detected', {
        correlationId: attempt.command.correlationId,
        transactionId: transaction.id,
        walletId: transaction.walletId,
        providerId: transaction.providerId,
      });
    });
  }

  private async recordExternalIdConflict(
    repos: Repositories,
    attempt: SubmissionAttempt,
    existing: WagerTransaction,
    inbox: InboxMessage | undefined,
    now: Date,
  ): Promise<SubmitResult> {
    const { command } = attempt;
    const body = externalTransactionIdConflictProblem(existing.id);
    await storeRecord(
      repos,
      attempt,
      { httpStatus: 409, body, transactionId: undefined },
      inbox,
      now,
    );
    attempt.afterCommit.push(() => {
      this.deps.metrics.idempotencyConflict(command.channel, 'external_transaction_id');
    });
    return { kind: 'external-id-conflict', body, replay: false };
  }

  private async recordWalletNotFound(
    repos: Repositories,
    attempt: SubmissionAttempt,
    inbox: InboxMessage | undefined,
    now: Date,
  ): Promise<SubmitResult> {
    const body = this.deps.outcomeMapper.walletNotFound(attempt.command);
    await storeRecord(
      repos,
      attempt,
      { httpStatus: 422, body, transactionId: undefined },
      inbox,
      now,
    );
    this.noteNewOutcome(attempt, body.status, body.failureCode);
    return { kind: 'outcome', httpStatus: 422, body, replay: false };
  }

  private noteLockAcquired(attempt: SubmissionAttempt, locked: LockedWallet): void {
    const { channel } = attempt.command;
    attempt.afterCommit.push(() => {
      this.deps.metrics.walletLockWait(channel, locked.waitSeconds);
      if (locked.contended) {
        this.deps.metrics.lockConflict('contended');
      }
    });
  }

  private noteNewOutcome(
    attempt: SubmissionAttempt,
    status: TransactionResultBody['status'],
    failureCode: FailureCode | undefined,
  ): void {
    const { channel, kind } = attempt.command;
    attempt.afterCommit.push(() => {
      this.deps.metrics.transactionRecorded({
        status,
        kind,
        channel,
        failureCode: failureCode ?? 'none',
      });
      const elapsedMs = this.deps.clock.now().getTime() - attempt.startedAt.getTime();
      this.deps.metrics.processingDuration({ channel, status }, elapsedMs / 1000);
    });
  }

  private emitAfterCommit(attempt: SubmissionAttempt): void {
    for (const emit of attempt.afterCommit) {
      emit();
    }
  }
}
