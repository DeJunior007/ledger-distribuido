import { OutboxMessage } from '@domain/messaging/outbox-message';
import { OutboxMessageRecord } from '../records/outbox-messages.record';
import { corruptedRow, isRecord } from './persisted-values.mapper';

export function toDomain(record: OutboxMessageRecord): OutboxMessage {
  if (!isRecord(record.payload)) {
    throw corruptedRow();
  }
  return OutboxMessage.rehydrate({
    id: record.id,
    aggregateId: record.aggregateId,
    eventType: record.eventType,
    payload: record.payload,
    occurredAt: record.occurredAt,
    attempts: record.attempts,
    permanentFailures: record.permanentFailures,
    nextAttemptAt: record.nextAttemptAt,
    lockedUntil: record.lockedUntil ?? undefined,
    lockedBy: record.lockedBy ?? undefined,
    publishedAt: record.publishedAt ?? undefined,
    parkedAt: record.parkedAt ?? undefined,
    lastErrorCode: record.lastErrorCode ?? undefined,
  });
}

export function toRecord(
  message: OutboxMessage,
  existing?: OutboxMessageRecord,
): OutboxMessageRecord {
  const state = message.toState();
  if (existing !== undefined) {
    existing.attempts = state.attempts;
    existing.permanentFailures = state.permanentFailures;
    existing.nextAttemptAt = state.nextAttemptAt;
    existing.lockedUntil = state.lockedUntil ?? null;
    existing.lockedBy = state.lockedBy ?? null;
    existing.publishedAt = state.publishedAt ?? null;
    existing.parkedAt = state.parkedAt ?? null;
    existing.lastErrorCode = state.lastErrorCode ?? null;
    return existing;
  }
  return new OutboxMessageRecord({
    id: state.id,
    aggregateId: state.aggregateId,
    eventType: state.eventType,
    payload: state.payload,
    occurredAt: state.occurredAt,
    attempts: state.attempts,
    permanentFailures: state.permanentFailures,
    nextAttemptAt: state.nextAttemptAt,
    lockedUntil: state.lockedUntil ?? null,
    lockedBy: state.lockedBy ?? null,
    publishedAt: state.publishedAt ?? null,
    parkedAt: state.parkedAt ?? null,
    lastErrorCode: state.lastErrorCode ?? null,
  });
}
