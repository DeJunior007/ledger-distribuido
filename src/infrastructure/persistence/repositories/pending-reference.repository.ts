import { ref } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type {
  PendingReferenceRepositoryPort,
  PendingReferenceRetry,
} from '@application/ports/repositories/pending-reference-repository.port';
import { PendingReferenceRetryRecord } from '../records/pending-reference-retries.record';
import { WagerTransactionRecord } from '../records/wager-transactions.record';
import {
  parsePendingReferenceAffectedRows,
  parsePendingReferenceOpenCount,
  parsePendingReferenceRenewedRows,
  parsePendingReferenceRetryRows,
  type PendingReferenceRetryRow,
} from '../rows/pending-reference-retries.row';

const CLAIM_DUE_SQL = `UPDATE pending_reference_retries
SET locked_until = now() + (? * interval '1 millisecond'), locked_by = ?
WHERE transaction_id IN (
  SELECT transaction_id FROM pending_reference_retries
  WHERE resolved_at IS NULL
    AND next_attempt_at <= now()
    AND (locked_until IS NULL OR locked_until < now())
  ORDER BY next_attempt_at
  LIMIT ?
  FOR UPDATE SKIP LOCKED
)
RETURNING *`;

const RENEW_LEASE_SQL = `UPDATE pending_reference_retries
SET locked_until = now() + (? * interval '1 millisecond')
WHERE transaction_id = ? AND locked_by = ? AND resolved_at IS NULL
RETURNING transaction_id`;

const SCHEDULE_NEXT_SQL = `UPDATE pending_reference_retries
SET next_attempt_at = ?, attempts = ?, consecutive_errors = ?, locked_until = NULL, locked_by = NULL
WHERE transaction_id = ? AND locked_by = ? AND resolved_at IS NULL`;

const MARK_RESOLVED_SQL = `UPDATE pending_reference_retries
SET resolved_at = ?, locked_until = NULL, locked_by = NULL
WHERE transaction_id = ? AND resolved_at IS NULL`;

const WAKE_DEPENDENTS_SQL = `UPDATE pending_reference_retries r
SET next_attempt_at = now()
FROM wager_transactions t
WHERE t.id = r.transaction_id
  AND t.status = 'PENDING_REFERENCE'
  AND t.provider_id = ?
  AND t.reference_external_transaction_id = ?
  AND r.resolved_at IS NULL
  AND r.next_attempt_at > now()`;

const OPEN_COUNT_SQL = `SELECT count(*)::int AS open FROM pending_reference_retries WHERE resolved_at IS NULL`;

const toRetry = (row: PendingReferenceRetryRow): PendingReferenceRetry => ({
  transactionId: row.transaction_id,
  attempts: row.attempts,
  consecutiveErrors: row.consecutive_errors,
  nextAttemptAt: row.next_attempt_at,
  deadlineAt: row.deadline_at,
  lockedUntil: row.locked_until ?? undefined,
  lockedBy: row.locked_by ?? undefined,
  resolvedAt: row.resolved_at ?? undefined,
  createdAt: row.created_at,
});

export class MikroOrmPendingReferenceRepository implements PendingReferenceRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  insert(retry: PendingReferenceRetry): void {
    this.em.persist(
      new PendingReferenceRetryRecord({
        transaction: ref(WagerTransactionRecord, retry.transactionId),
        attempts: retry.attempts,
        consecutiveErrors: retry.consecutiveErrors,
        nextAttemptAt: retry.nextAttemptAt,
        deadlineAt: retry.deadlineAt,
        lockedUntil: retry.lockedUntil ?? null,
        lockedBy: retry.lockedBy ?? null,
        resolvedAt: retry.resolvedAt ?? null,
        createdAt: retry.createdAt,
      }),
    );
  }

  async claimDue(input: {
    instanceId: string;
    leaseMs: number;
    limit: number;
  }): Promise<PendingReferenceRetry[]> {
    const rows = await this.em.execute(CLAIM_DUE_SQL, [
      input.leaseMs,
      input.instanceId,
      input.limit,
    ]);
    return parsePendingReferenceRetryRows(rows)
      .map(toRetry)
      .sort((left, right) => left.nextAttemptAt.getTime() - right.nextAttemptAt.getTime());
  }

  async renewLease(transactionId: string, instanceId: string, leaseMs: number): Promise<boolean> {
    const rows = await this.em.execute(RENEW_LEASE_SQL, [leaseMs, transactionId, instanceId]);
    return parsePendingReferenceRenewedRows(rows) > 0;
  }

  async scheduleNext(input: {
    transactionId: string;
    instanceId: string;
    nextAttemptAt: Date;
    attempts: number;
    consecutiveErrors: number;
  }): Promise<boolean> {
    const result = await this.em.execute(
      SCHEDULE_NEXT_SQL,
      [
        input.nextAttemptAt,
        input.attempts,
        input.consecutiveErrors,
        input.transactionId,
        input.instanceId,
      ],
      'run',
    );
    return parsePendingReferenceAffectedRows(result) > 0;
  }

  async markResolved(transactionId: string, at: Date): Promise<void> {
    const result = await this.em.execute(MARK_RESOLVED_SQL, [at, transactionId], 'run');
    parsePendingReferenceAffectedRows(result);
  }

  async wakeDependents(providerId: string, externalTransactionId: string): Promise<number> {
    const result = await this.em.execute(
      WAKE_DEPENDENTS_SQL,
      [providerId, externalTransactionId],
      'run',
    );
    return parsePendingReferenceAffectedRows(result);
  }

  async openCount(): Promise<number> {
    return parsePendingReferenceOpenCount(await this.em.execute(OPEN_COUNT_SQL));
  }
}
