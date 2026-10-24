import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxGauges } from '@application/ports/outbox-gauges';
import type { OutboxRepositoryPort } from '@application/ports/repositories/outbox-repository.port';
import type { OutboxMessage } from '@domain/messaging/outbox-message';
import * as outboxMapper from '../mappers/outbox-message.mapper';
import { OutboxMessageRecord } from '../records/outbox-messages.record';
import {
  parseOutboxAffectedRows,
  parseOutboxGaugesRow,
  parseOutboxMessageRows,
  type OutboxMessageRow,
} from '../rows/outbox-messages.row';

const CLAIM_DUE_SQL = `UPDATE outbox_messages
SET locked_until = now() + (? * interval '1 millisecond'), locked_by = ?
WHERE id IN (
  SELECT id FROM outbox_messages
  WHERE published_at IS NULL
    AND next_attempt_at <= now()
    AND (locked_until IS NULL OR locked_until < now())
  ORDER BY next_attempt_at
  LIMIT ?
  FOR UPDATE SKIP LOCKED
)
RETURNING *`;

const MARK_PUBLISHED_SQL = `UPDATE outbox_messages
SET published_at = ?, locked_until = NULL, locked_by = NULL
WHERE id = ? AND locked_by = ? AND published_at IS NULL`;

const SAVE_RETRY_SQL = `UPDATE outbox_messages
SET attempts = ?, permanent_failures = ?, next_attempt_at = ?, parked_at = ?,
    last_error_code = ?, locked_until = NULL, locked_by = NULL
WHERE id = ? AND locked_by = ? AND published_at IS NULL`;

const REQUEUE_PARKED_SQL = `UPDATE outbox_messages SET next_attempt_at = now()
WHERE id IN (
  SELECT id FROM outbox_messages
  WHERE parked_at IS NOT NULL AND published_at IS NULL
  ORDER BY id
  LIMIT ?
  FOR UPDATE SKIP LOCKED
)`;

const GAUGES_SQL = `SELECT
  (count(*) FILTER (WHERE parked_at IS NULL))::int AS pending,
  (count(*) FILTER (WHERE parked_at IS NOT NULL))::int AS parked,
  (count(*) FILTER (WHERE parked_at IS NULL AND attempts >= 10))::int AS stuck,
  coalesce(extract(epoch FROM now() - min(occurred_at) FILTER (WHERE parked_at IS NULL)), 0)::float8 AS lag_seconds
FROM outbox_messages
WHERE published_at IS NULL`;

const toRecord = (row: OutboxMessageRow): OutboxMessageRecord =>
  new OutboxMessageRecord({
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    occurredAt: row.occurred_at,
    attempts: row.attempts,
    permanentFailures: row.permanent_failures,
    nextAttemptAt: row.next_attempt_at,
    lockedUntil: row.locked_until,
    lockedBy: row.locked_by,
    publishedAt: row.published_at,
    parkedAt: row.parked_at,
    lastErrorCode: row.last_error_code,
  });

export class MikroOrmOutboxRepository implements OutboxRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  enqueue(message: OutboxMessage): void {
    this.em.persist(outboxMapper.toRecord(message));
  }

  async claimDue(input: {
    instanceId: string;
    leaseMs: number;
    limit: number;
  }): Promise<OutboxMessage[]> {
    const rows = await this.em.execute(CLAIM_DUE_SQL, [
      input.leaseMs,
      input.instanceId,
      input.limit,
    ]);
    return parseOutboxMessageRows(rows)
      .map((row) => outboxMapper.toDomain(toRecord(row)))
      .sort((left, right) => left.nextAttemptAt.getTime() - right.nextAttemptAt.getTime());
  }

  async markPublished(id: string, instanceId: string, at: Date): Promise<boolean> {
    const result = await this.em.execute(MARK_PUBLISHED_SQL, [at, id, instanceId], 'run');
    return parseOutboxAffectedRows(result) > 0;
  }

  async saveRetry(message: OutboxMessage, instanceId: string): Promise<boolean> {
    const state = message.toState();
    const result = await this.em.execute(
      SAVE_RETRY_SQL,
      [
        state.attempts,
        state.permanentFailures,
        state.nextAttemptAt,
        state.parkedAt ?? null,
        state.lastErrorCode ?? null,
        state.id,
        instanceId,
      ],
      'run',
    );
    return parseOutboxAffectedRows(result) > 0;
  }

  async requeueParked(limit: number | undefined): Promise<number> {
    const result = await this.em.execute(REQUEUE_PARKED_SQL, [limit ?? null], 'run');
    return parseOutboxAffectedRows(result);
  }

  async gauges(): Promise<OutboxGauges> {
    const row = parseOutboxGaugesRow(await this.em.execute(GAUGES_SQL));
    return {
      pending: row.pending,
      parked: row.parked,
      stuck: row.stuck,
      lagSeconds: row.lag_seconds,
    };
  }
}
