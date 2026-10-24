import type { IdempotencyRecord } from '@domain/idempotency/idempotency-record';
import type { ProblemBody } from '@domain/idempotency/response-bodies';
import { FAILURE_CODE_METADATA, FailureCode } from '@domain/shared/failure-code';
import type {
  SubmitResult,
  SubmitWagerTransactionCommand,
} from '@application/commands/submit-wager-transaction.command';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import type { MetricsPort } from '@application/ports/metrics.port';
import type { ReadRepositories, UnitOfWorkPort } from '@application/ports/unit-of-work.port';

export const SUBMISSION_CONSUMER = 'wager-transactions-consumer';

export type InboxReference = NonNullable<SubmitWagerTransactionCommand['inbox']>;

export type FastPathDecision = { kind: 'resolved'; result: SubmitResult } | { kind: 'proceed' };

type FastPathLookup =
  | { kind: 'inbox-mismatch' }
  | { kind: 'looked-up'; duplicate: boolean; record: IdempotencyRecord | undefined };

function problem(
  failureCode: FailureCode,
  title: string,
  detail: string,
  extra: Pick<ProblemBody, 'transactionId' | 'idempotentReplay'>,
): ProblemBody {
  const metadata = FAILURE_CODE_METADATA[failureCode];
  return {
    type: `urn:jungle:problem:${failureCode}`,
    title,
    status: metadata.httpStatus,
    detail,
    failureCode,
    retryable: metadata.retryable,
    action: metadata.action,
    ...extra,
  };
}

export function idempotencyKeyConflictProblem(): ProblemBody {
  return problem(
    FailureCode.IdempotencyKeyConflict,
    'Idempotency key conflict',
    'The idempotency key was already used with a different payload',
    {},
  );
}

export function externalTransactionIdConflictProblem(existingTransactionId: string): ProblemBody {
  return problem(
    FailureCode.ExternalTransactionIdConflict,
    'External transaction id conflict',
    'The external transaction id was already used by another transaction',
    { transactionId: existingTransactionId, idempotentReplay: false },
  );
}

export function idempotencyKeyConflict(): SubmitResult {
  return { kind: 'idempotency-key-conflict', body: idempotencyKeyConflictProblem() };
}

export function replayOf(record: IdempotencyRecord): SubmitResult {
  const { httpStatus, body } = record.toReplay();
  if ('title' in body) {
    if (httpStatus !== 409) {
      throw new TechnicalError(ErrorClass.Deterministic, 'deterministic');
    }
    return { kind: 'external-id-conflict', body, replay: true };
  }
  if (httpStatus === 409) {
    throw new TechnicalError(ErrorClass.Deterministic, 'deterministic');
  }
  return { kind: 'outcome', httpStatus, body, replay: true };
}

export function inboxOf(command: SubmitWagerTransactionCommand): InboxReference | undefined {
  const expectsInbox = command.channel === 'sqs';
  if (expectsInbox !== (command.inbox !== undefined)) {
    throw new TechnicalError(ErrorClass.Deterministic, 'deterministic');
  }
  return command.inbox;
}

export class SubmissionFastPath {
  constructor(
    private readonly uow: UnitOfWorkPort,
    private readonly metrics: MetricsPort,
  ) {}

  async check(
    command: SubmitWagerTransactionCommand,
    payloadHash: string,
  ): Promise<FastPathDecision> {
    const lookup = await this.uow.read((repos) => this.lookUp(repos, command));
    if (lookup.kind === 'inbox-mismatch') {
      this.metrics.inboxPayloadMismatch(SUBMISSION_CONSUMER);
      return { kind: 'resolved', result: { kind: 'inbox-payload-mismatch' } };
    }
    if (lookup.duplicate) {
      this.metrics.inboxDuplicate(SUBMISSION_CONSUMER);
    }
    const { record } = lookup;
    if (record === undefined) {
      if (lookup.duplicate) {
        throw new TechnicalError(ErrorClass.Deterministic, 'inbox_without_record');
      }
      return { kind: 'proceed' };
    }
    if (!record.matches(payloadHash)) {
      this.metrics.idempotencyConflict(command.channel, 'idempotency_key');
      return { kind: 'resolved', result: idempotencyKeyConflict() };
    }
    this.metrics.idempotencyReplay(command.channel);
    return { kind: 'resolved', result: replayOf(record) };
  }

  private async lookUp(
    repos: ReadRepositories,
    command: SubmitWagerTransactionCommand,
  ): Promise<FastPathLookup> {
    const delivery = await this.inboxDelivery(repos, inboxOf(command));
    if (delivery === 'mismatch') {
      return { kind: 'inbox-mismatch' };
    }
    const record = await repos.idempotency.find(command.providerId, command.idempotencyKey);
    return { kind: 'looked-up', duplicate: delivery === 'duplicate', record };
  }

  private async inboxDelivery(
    repos: ReadRepositories,
    inbox: InboxReference | undefined,
  ): Promise<'first' | 'duplicate' | 'mismatch'> {
    if (inbox === undefined) {
      return 'first';
    }
    const received = await repos.inbox.find(SUBMISSION_CONSUMER, inbox.messageId);
    if (received === undefined) {
      return 'first';
    }
    return received.matchesPayload(inbox.payloadHash) ? 'duplicate' : 'mismatch';
  }
}
