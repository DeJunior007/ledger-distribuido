import {
  PendingReferenceRepositoryPort,
  type PendingReferenceRetry,
} from '@application/ports/repositories/pending-reference-repository.port';
import { WagerTransactionStatus } from '@domain/wagering/wager-transaction-status';
import { compositeKey, settle } from './in-memory-unit-of-work.fake';
import type { FakeTransaction } from './in-memory-unit-of-work.fake';

const isOpen = (row: PendingReferenceRetry): boolean => row.resolvedAt === undefined;

export class InMemoryPendingReferenceRepository extends PendingReferenceRepositoryPort {
  constructor(private readonly transaction: FakeTransaction) {
    super();
  }

  insert(retry: PendingReferenceRetry): void {
    this.transaction.pendingReferences.insert(retry);
  }

  claimDue(input: {
    instanceId: string;
    leaseMs: number;
    limit: number;
  }): Promise<PendingReferenceRetry[]> {
    return settle(() => {
      const now = this.transaction.database.clock.now();
      const lockedUntil = new Date(now.getTime() + input.leaseMs);
      const claimed: PendingReferenceRetry[] = [];
      const due = this.transaction.pendingReferences
        .rows()
        .filter(
          (row) =>
            isOpen(row) &&
            row.nextAttemptAt.getTime() <= now.getTime() &&
            (row.lockedUntil === undefined || row.lockedUntil.getTime() < now.getTime()),
        )
        .sort((left, right) => left.nextAttemptAt.getTime() - right.nextAttemptAt.getTime());
      for (const row of due) {
        if (claimed.length >= input.limit) {
          break;
        }
        if (!this.tryLockRow(row.transactionId)) {
          continue;
        }
        const leased = { ...row, lockedUntil, lockedBy: input.instanceId };
        this.transaction.pendingReferences.update(leased);
        claimed.push({ ...leased });
      }
      return claimed;
    });
  }

  async renewLease(transactionId: string, instanceId: string, leaseMs: number): Promise<boolean> {
    const row = await this.lockOwnedRow(transactionId, instanceId);
    if (row === undefined) {
      return false;
    }
    const now = this.transaction.database.clock.now();
    this.transaction.pendingReferences.update({
      ...row,
      lockedUntil: new Date(now.getTime() + leaseMs),
    });
    return true;
  }

  async scheduleNext(input: {
    transactionId: string;
    instanceId: string;
    nextAttemptAt: Date;
    attempts: number;
    consecutiveErrors: number;
  }): Promise<boolean> {
    const row = await this.lockOwnedRow(input.transactionId, input.instanceId);
    if (row === undefined) {
      return false;
    }
    this.transaction.pendingReferences.update({
      ...row,
      nextAttemptAt: input.nextAttemptAt,
      attempts: input.attempts,
      consecutiveErrors: input.consecutiveErrors,
      lockedUntil: undefined,
      lockedBy: undefined,
    });
    return true;
  }

  async markResolved(transactionId: string, at: Date): Promise<void> {
    await this.lockRow(transactionId);
    const row = this.transaction.pendingReferences.find(transactionId);
    if (row === undefined || !isOpen(row)) {
      return;
    }
    this.transaction.pendingReferences.update({
      ...row,
      resolvedAt: at,
      lockedUntil: undefined,
      lockedBy: undefined,
    });
  }

  wakeDependents(providerId: string, externalTransactionId: string): Promise<number> {
    return settle(() => {
      const now = this.transaction.database.clock.now();
      const waiting = new Set(
        this.transaction.transactions
          .rows()
          .filter(
            (row) =>
              row.status === WagerTransactionStatus.PendingReference &&
              row.providerId === providerId &&
              row.referenceExternalTransactionId === externalTransactionId,
          )
          .map((row) => row.id),
      );
      let woken = 0;
      for (const row of this.transaction.pendingReferences.rows()) {
        if (
          !waiting.has(row.transactionId) ||
          !isOpen(row) ||
          row.nextAttemptAt.getTime() <= now.getTime()
        ) {
          continue;
        }
        this.transaction.pendingReferences.update({ ...row, nextAttemptAt: now });
        woken += 1;
      }
      return woken;
    });
  }

  openCount(): Promise<number> {
    return settle(() => this.transaction.pendingReferences.rows().filter(isOpen).length);
  }

  private tryLockRow(transactionId: string): boolean {
    return this.transaction.database.locks.tryAcquire(
      compositeKey('pending_reference_retries', transactionId),
      this.transaction.id,
    );
  }

  private async lockRow(transactionId: string): Promise<void> {
    await this.transaction.database.locks.acquire(
      compositeKey('pending_reference_retries', transactionId),
      this.transaction.id,
    );
  }

  private async lockOwnedRow(
    transactionId: string,
    instanceId: string,
  ): Promise<PendingReferenceRetry | undefined> {
    await this.lockRow(transactionId);
    const row = this.transaction.pendingReferences.find(transactionId);
    return row !== undefined && isOpen(row) && row.lockedBy === instanceId ? row : undefined;
  }
}
