import { EntitySchema } from '@mikro-orm/core';
import { OutboxMessageRecord } from '../records/outbox-messages.record';

export const OutboxMessageEntitySchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', fieldName: 'id', primary: true },
    aggregateId: { type: 'uuid', fieldName: 'aggregate_id' },
    eventType: { type: 'text', fieldName: 'event_type' },
    payload: { type: 'json', columnType: 'jsonb', fieldName: 'payload' },
    occurredAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'occurred_at' },
    attempts: { type: 'integer', fieldName: 'attempts', default: 0 },
    permanentFailures: { type: 'integer', fieldName: 'permanent_failures', default: 0 },
    nextAttemptAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'next_attempt_at' },
    lockedUntil: {
      type: 'datetime',
      columnType: 'timestamptz',
      fieldName: 'locked_until',
      nullable: true,
    },
    lockedBy: { type: 'text', fieldName: 'locked_by', nullable: true },
    publishedAt: {
      type: 'datetime',
      columnType: 'timestamptz',
      fieldName: 'published_at',
      nullable: true,
    },
    parkedAt: {
      type: 'datetime',
      columnType: 'timestamptz',
      fieldName: 'parked_at',
      nullable: true,
    },
    lastErrorCode: { type: 'text', fieldName: 'last_error_code', nullable: true },
  },
});
