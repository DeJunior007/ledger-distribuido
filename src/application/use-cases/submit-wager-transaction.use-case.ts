import { IdempotencyRecord } from '@domain/idempotency/idempotency-record';
import type { ProblemBody, TransactionResultBody } from '@domain/idempotency/response-bodies';
import { InboxMessage } from '@domain/messaging/inbox-message';
import type { FailureCode } from '@domain/shared/failure-code';
import type { TransactionApplier } from '@domain/wagering/transaction-applier';
import type { WagerTransaction } from '@domain/wagering/wager-transaction';
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
  SUBMISSION_CONSUMER,
  SubmissionFastPath,
  externalTransactionIdConflictProblem,
  idempotencyKeyConflict,
  inboxOf,
  replayOf,
} from '@application/services/submission-fast-path';

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
    const decision = await this.fastPath.check(command, payloadHash);
    if (decision.kind === 'resolved') {
      return decision.result;
    }
    return this.runGuarded({
      command,
      payloadHash,
      startedAt,
      afterCommit: [],
      rollback: undefined,
    });
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
    const inbox = await this.receiveInbox(repos, command, now);
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
      await this.markInboxProcessed(repos, inbox, now);
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

  private applyAndPersist(guarded: GuardedSubmission): Promise<SubmitResult> {
    return Promise.reject(
      new TechnicalError(ErrorClass.Deterministic, 'deterministic', { cause: guarded }),
    );
  }

  private async receiveInbox(
    repos: Repositories,
    command: SubmitWagerTransactionCommand,
    now: Date,
  ): Promise<InboxMessage | undefined> {
    const reference = inboxOf(command);
    if (reference === undefined) {
      return undefined;
    }
    const message = InboxMessage.receive({
      consumerName: SUBMISSION_CONSUMER,
      messageId: reference.messageId,
      payloadHash: reference.payloadHash,
      now,
    });
    if (!(await repos.inbox.tryInsert(message))) {
      throw new TechnicalError(ErrorClass.Race, 'inbox');
    }
    return message;
  }

  private async markInboxProcessed(
    repos: Repositories,
    inbox: InboxMessage | undefined,
    now: Date,
  ): Promise<void> {
    if (inbox === undefined) {
      return;
    }
    inbox.markProcessed(now);
    await repos.inbox.markProcessed(inbox);
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
    await this.storeRecord(repos, attempt, { httpStatus: 409, body }, inbox, now);
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
    await this.storeRecord(repos, attempt, { httpStatus: 422, body }, inbox, now);
    this.noteNewOutcome(attempt, body.status, body.failureCode);
    return { kind: 'outcome', httpStatus: 422, body, replay: false };
  }

  private async storeRecord(
    repos: Repositories,
    attempt: SubmissionAttempt,
    response:
      { httpStatus: 409; body: ProblemBody } | { httpStatus: 422; body: TransactionResultBody },
    inbox: InboxMessage | undefined,
    now: Date,
  ): Promise<void> {
    const { command, payloadHash } = attempt;
    repos.idempotency.insert(
      IdempotencyRecord.create({
        providerId: command.providerId,
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        transactionId: undefined,
        httpStatus: response.httpStatus,
        responseBody: response.body,
        createdAt: now,
      }),
    );
    await this.markInboxProcessed(repos, inbox, now);
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
