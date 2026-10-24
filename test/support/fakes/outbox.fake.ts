import type { OutboxGauges } from '@application/ports/outbox-gauges';
import { OutboxRepositoryPort } from '@application/ports/repositories/outbox-repository.port';
import { OutboxMessage, type OutboxMessageState } from '@domain/messaging/outbox-message';
import { compositeKey, settle } from './in-memory-unit-of-work.fake';
import type { FakeTransaction } from './in-memory-unit-of-work.fake';

const STUCK_ATTEMPTS = 10;

const isUnpublished = (row: OutboxMessageState): boolean => row.publishedAt === undefined;

const isParked = (row: OutboxMessageState): boolean => row.parkedAt !== undefined;

export class InMemoryOutboxRepository extends OutboxRepositoryPort {
  constructor(private readonly transaction: FakeTransaction) {
    super();
  }

  enqueue(message: OutboxMessage): void {
    this.transaction.outbox.insert(message.toState());
  }

  claimDue(input: {
    instanceId: string;
    leaseMs: number;
    limit: number;
  }): Promise<OutboxMessage[]> {
    return settle(() => {
      const now = this.transaction.database.clock.now();
      const lockedUntil = new Date(now.getTime() + input.leaseMs);
      const claimed: OutboxMessage[] = [];
      const due = this.transaction.outbox
        .rows()
        .filter(
          (row) =>
            isUnpublished(row) &&
            row.nextAttemptAt.getTime() <= now.getTime() &&
            (row.lockedUntil === undefined || row.lockedUntil.getTime() < now.getTime()),
        )
        .sort((left, right) => left.nextAttemptAt.getTime() - right.nextAttemptAt.getTime());
      for (const row of due) {
        if (claimed.length >= input.limit) {
          break;
        }
        if (!this.tryLockRow(row.id)) {
          continue;
        }
        const leased = { ...row, lockedUntil, lockedBy: input.instanceId };
        this.transaction.outbox.update(leased);
        claimed.push(OutboxMessage.rehydrate(leased));
      }
      return claimed;
    });
  }

  async markPublished(id: string, instanceId: string, at: Date): Promise<boolean> {
    const row = await this.lockLeasedRow(id, instanceId);
    if (row === undefined) {
      return false;
    }
    this.transaction.outbox.update({
      ...row,
      publishedAt: at,
      lockedUntil: undefined,
      lockedBy: undefined,
    });
    return true;
  }

  async saveRetry(message: OutboxMessage, instanceId: string): Promise<boolean> {
    const row = await this.lockLeasedRow(message.id, instanceId);
    if (row === undefined) {
      return false;
    }
    const retry = message.toState();
    this.transaction.outbox.update({
      ...row,
      attempts: retry.attempts,
      permanentFailures: retry.permanentFailures,
      nextAttemptAt: retry.nextAttemptAt,
      parkedAt: retry.parkedAt,
      lastErrorCode: retry.lastErrorCode,
      lockedUntil: undefined,
      lockedBy: undefined,
    });
    return true;
  }

  requeueParked(limit: number | undefined): Promise<number> {
    return settle(() => {
      const now = this.transaction.database.clock.now();
      let requeued = 0;
      const parked = this.transaction.outbox
        .rows()
        .filter((row) => isParked(row) && isUnpublished(row))
        .sort((left, right) => left.id.localeCompare(right.id));
      for (const row of parked) {
        if (limit !== undefined && requeued >= limit) {
          break;
        }
        if (!this.tryLockRow(row.id)) {
          continue;
        }
        this.transaction.outbox.update({ ...row, nextAttemptAt: now });
        requeued += 1;
      }
      return requeued;
    });
  }

  gauges(now: Date): Promise<OutboxGauges> {
    return settle(() => {
      const unpublished = this.transaction.outbox.rows().filter(isUnpublished);
      const flowing = unpublished.filter((row) => !isParked(row));
      const oldest = Math.min(...flowing.map((row) => row.occurredAt.getTime()));
      return {
        pending: flowing.length,
        parked: unpublished.length - flowing.length,
        stuck: flowing.filter((row) => row.attempts >= STUCK_ATTEMPTS).length,
        lagSeconds: flowing.length === 0 ? 0 : (now.getTime() - oldest) / 1000,
      };
    });
  }

  private tryLockRow(id: string): boolean {
    return this.transaction.database.locks.tryAcquire(
      compositeKey('outbox_messages', id),
      this.transaction.id,
    );
  }

  private async lockLeasedRow(
    id: string,
    instanceId: string,
  ): Promise<OutboxMessageState | undefined> {
    await this.transaction.database.locks.acquire(
      compositeKey('outbox_messages', id),
      this.transaction.id,
    );
    const row = this.transaction.outbox.find(id);
    if (row?.lockedBy !== instanceId) {
      return undefined;
    }
    return isUnpublished(row) ? row : undefined;
  }
}
