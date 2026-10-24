import type { Ref } from '@mikro-orm/core';
import type { WagerTransactionRecord } from './wager-transactions.record';

export interface PendingReferenceRetryRecordProps {
  transaction: Ref<WagerTransactionRecord>;
  attempts: number;
  consecutiveErrors: number;
  nextAttemptAt: Date;
  deadlineAt: Date;
  lockedUntil: Date | null;
  lockedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

export class PendingReferenceRetryRecord {
  transaction: Ref<WagerTransactionRecord>;
  attempts: number;
  consecutiveErrors: number;
  nextAttemptAt: Date;
  deadlineAt: Date;
  lockedUntil: Date | null;
  lockedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;

  constructor(props: PendingReferenceRetryRecordProps) {
    this.transaction = props.transaction;
    this.attempts = props.attempts;
    this.consecutiveErrors = props.consecutiveErrors;
    this.nextAttemptAt = props.nextAttemptAt;
    this.deadlineAt = props.deadlineAt;
    this.lockedUntil = props.lockedUntil;
    this.lockedBy = props.lockedBy;
    this.resolvedAt = props.resolvedAt;
    this.createdAt = props.createdAt;
  }
}
