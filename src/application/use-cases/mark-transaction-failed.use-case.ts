import type { TransactionResultBody } from '@domain/idempotency/response-bodies';
import { WagerTransactionFailed } from '@domain/messaging/events/wager-transaction-failed.event';
import type { InboxMessage } from '@domain/messaging/inbox-message';
import { OutboxMessage } from '@domain/messaging/outbox-message';
import type { FailureCode } from '@domain/shared/failure-code';
import { Money } from '@domain/shared/money';
import { WagerTransaction } from '@domain/wagering/wager-transaction';
import type { Wallet } from '@domain/wallet/wallet';
import type {
  SubmitResult,
  SubmitWagerTransactionCommand,
} from '@application/commands/submit-wager-transaction.command';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import { RollbackSignal } from '@application/errors/rollback-signal';
import type { ClockPort } from '@application/ports/clock.port';
import type { ContextEnricher } from '@application/ports/context-enricher';
import type { HasherPort } from '@application/ports/hasher.port';
import type { IdGeneratorPort } from '@application/ports/id-generator.port';
import type { LoggerPort } from '@application/ports/logger.port';
import type { MetricsPort } from '@application/ports/metrics.port';
import type { LockedWallet } from '@application/ports/repositories/wallet-repository.port';
import type { TracerPort } from '@application/ports/tracer.port';
import type { Repositories, UnitOfWorkPort } from '@application/ports/unit-of-work.port';
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

const MAX_FAILURE_ATTEMPTS = 2;

const isRace = (error: unknown): error is TechnicalError =>
  error instanceof TechnicalError && error.errorClass === ErrorClass.Race;

export interface MarkTransactionFailedDependencies {
  uow: UnitOfWorkPort;
  clock: ClockPort;
  ids: IdGeneratorPort;
  hasher: HasherPort;
  logger: LoggerPort;
  metrics: MetricsPort;
  tracer: TracerPort;
  enrich: ContextEnricher;
  outcomeMapper: OutcomeMapper;
}

interface FailureAttempt {
  readonly command: SubmitWagerTransactionCommand;
  readonly payloadHash: string;
  readonly startedAt: Date;
  readonly afterCommit: (() => void)[];
  rollback: RollbackSignal<SubmitResult> | undefined;
}

export class MarkTransactionFailedUseCase {
  private readonly fastPath: SubmissionFastPath;

  constructor(private readonly deps: MarkTransactionFailedDependencies) {
    this.fastPath = new SubmissionFastPath(deps.uow, deps.metrics);
  }

  execute(command: SubmitWagerTransactionCommand): Promise<SubmitResult> {
    return this.deps.tracer.inSpan(
      'usecase.mark_transaction_failed',
      { channel: command.channel, providerId: command.providerId, walletId: command.walletId },
      () => this.markFailed(command),
    );
  }

  private markFailed(command: SubmitWagerTransactionCommand): Promise<SubmitResult> {
    this.deps.enrich({ walletId: command.walletId, providerId: command.providerId });
    const payloadHash = computePayloadHash(command, this.deps.hasher);
    const startedAt = this.deps.clock.now();
    return this.markAttempt(command, payloadHash, startedAt, 1);
  }

  private async markAttempt(
    command: SubmitWagerTransactionCommand,
    payloadHash: string,
    startedAt: Date,
    attemptNumber: number,
  ): Promise<SubmitResult> {
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
      this.deps.metrics.lockConflict('unique_retry');
      const decision = await this.fastPath.check(command, payloadHash);
      if (decision.kind === 'resolved') {
        return decision.result;
      }
      if (attemptNumber >= MAX_FAILURE_ATTEMPTS) {
        throw new TechnicalError(ErrorClass.Transient, 'race_repeated', { cause: error });
      }
      return this.markAttempt(command, payloadHash, startedAt, attemptNumber + 1);
    }
  }

  private async runGuarded(attempt: FailureAttempt): Promise<SubmitResult> {
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

  private async guard(repos: Repositories, attempt: FailureAttempt): Promise<SubmitResult> {
    const { command, payloadHash } = attempt;
    const now = this.deps.clock.now();
    const inbox = await receiveInbox(repos, command, now);
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
    const existing = await repos.transactions.findByProviderAndExternalId(
      command.providerId,
      command.externalTransactionId,
      { refresh: true },
    );
    if (existing !== undefined) {
      return this.recordExternalIdConflict(repos, attempt, existing, inbox, now);
    }
    return this.recordFailure(repos, attempt, locked.wallet, inbox, now);
  }

  private async recordFailure(
    repos: Repositories,
    attempt: FailureAttempt,
    wallet: Wallet,
    inbox: InboxMessage | undefined,
    now: Date,
  ): Promise<SubmitResult> {
    const { command, payloadHash } = attempt;
    const transaction = WagerTransaction.failNew({
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
      balanceSnapshot: wallet.balance,
    });
    this.deps.enrich({ transactionId: transaction.id });
    repos.transactions.insert(transaction);
    repos.outbox.enqueue(
      OutboxMessage.enqueue(
        WagerTransactionFailed.from(transaction, wallet, {
          eventId: this.deps.ids.next(),
          correlationId: command.correlationId,
          causationId: command.causationId,
          occurredAt: now,
        }),
      ),
    );
    const body = this.deps.outcomeMapper.toBody(transaction, { replay: false });
    await storeRecord(
      repos,
      attempt,
      { httpStatus: 500, body, transactionId: transaction.id },
      inbox,
      now,
    );
    this.noteNewOutcome(attempt, body.status, transaction.failureCode);
    return { kind: 'outcome', httpStatus: 500, body, replay: false };
  }

  private async recordExternalIdConflict(
    repos: Repositories,
    attempt: FailureAttempt,
    existing: WagerTransaction,
    inbox: InboxMessage | undefined,
    now: Date,
  ): Promise<SubmitResult> {
    const { channel } = attempt.command;
    const body = externalTransactionIdConflictProblem(existing.id);
    await storeRecord(
      repos,
      attempt,
      { httpStatus: 409, body, transactionId: undefined },
      inbox,
      now,
    );
    attempt.afterCommit.push(() => {
      this.deps.metrics.idempotencyConflict(channel, 'external_transaction_id');
    });
    return { kind: 'external-id-conflict', body, replay: false };
  }

  private async recordWalletNotFound(
    repos: Repositories,
    attempt: FailureAttempt,
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

  private noteLockAcquired(attempt: FailureAttempt, locked: LockedWallet): void {
    const { channel } = attempt.command;
    attempt.afterCommit.push(() => {
      this.deps.metrics.walletLockWait(channel, locked.waitSeconds);
      if (locked.contended) {
        this.deps.metrics.lockConflict('contended');
      }
    });
  }

  private noteNewOutcome(
    attempt: FailureAttempt,
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

  private emitAfterCommit(attempt: FailureAttempt): void {
    for (const emit of attempt.afterCommit) {
      emit();
    }
  }
}
