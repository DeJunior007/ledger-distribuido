import { EntitySchema } from '@mikro-orm/core';
import { PendingReferenceRetryRecord } from '../records/pending-reference-retries.record';
import { WagerTransactionRecord } from '../records/wager-transactions.record';

export const PendingReferenceRetryEntitySchema = new EntitySchema<PendingReferenceRetryRecord>({
  class: PendingReferenceRetryRecord,
  tableName: 'pending_reference_retries',
  properties: {
    transaction: {
      kind: 'm:1',
      entity: () => WagerTransactionRecord,
      ref: true,
      fieldName: 'transaction_id',
      primary: true,
    },
    attempts: { type: 'integer', fieldName: 'attempts', default: 0 },
    consecutiveErrors: { type: 'integer', fieldName: 'consecutive_errors', default: 0 },
    nextAttemptAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'next_attempt_at' },
    deadlineAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'deadline_at' },
    lockedUntil: {
      type: 'datetime',
      columnType: 'timestamptz',
      fieldName: 'locked_until',
      nullable: true,
    },
    lockedBy: { type: 'text', fieldName: 'locked_by', nullable: true },
    resolvedAt: {
      type: 'datetime',
      columnType: 'timestamptz',
      fieldName: 'resolved_at',
      nullable: true,
    },
    createdAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'created_at' },
  },
});
