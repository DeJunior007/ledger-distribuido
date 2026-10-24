export interface OutboxMessageRecordProps {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  occurredAt: Date;
  attempts: number;
  permanentFailures: number;
  nextAttemptAt: Date;
  lockedUntil: Date | null;
  lockedBy: string | null;
  publishedAt: Date | null;
  parkedAt: Date | null;
  lastErrorCode: string | null;
}

export class OutboxMessageRecord {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  occurredAt: Date;
  attempts: number;
  permanentFailures: number;
  nextAttemptAt: Date;
  lockedUntil: Date | null;
  lockedBy: string | null;
  publishedAt: Date | null;
  parkedAt: Date | null;
  lastErrorCode: string | null;

  constructor(props: OutboxMessageRecordProps) {
    this.id = props.id;
    this.aggregateId = props.aggregateId;
    this.eventType = props.eventType;
    this.payload = props.payload;
    this.occurredAt = props.occurredAt;
    this.attempts = props.attempts;
    this.permanentFailures = props.permanentFailures;
    this.nextAttemptAt = props.nextAttemptAt;
    this.lockedUntil = props.lockedUntil;
    this.lockedBy = props.lockedBy;
    this.publishedAt = props.publishedAt;
    this.parkedAt = props.parkedAt;
    this.lastErrorCode = props.lastErrorCode;
  }
}
