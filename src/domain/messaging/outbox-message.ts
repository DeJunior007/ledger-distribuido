import { InvalidOutboxTransitionError } from './errors/invalid-outbox-transition.error';
import type { IntegrationEvent } from './integration-event';

const MAX_BACKOFF_MS = 300_000;
const PARKED_RETRY_MS = 3_600_000;
const PARK_AFTER_PERMANENT_FAILURES = 3;
const MAX_BACKOFF_EXPONENT = 20;

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  permanentFailures: number;
  nextAttemptAt: Date;
  lockedUntil: Date | undefined;
  lockedBy: string | undefined;
  publishedAt: Date | undefined;
  parkedAt: Date | undefined;
  lastErrorCode: string | undefined;
}

export type OutboxFailureKind = 'TRANSIENT' | 'PERMANENT';

export interface ScheduleRetryInput {
  now: Date;
  kind: OutboxFailureKind;
  errorCode: string;
  jitterRatio: number;
}

export class OutboxMessage {
  private constructor(private state: OutboxMessageState) {}

  get id(): string {
    return this.state.id;
  }

  get aggregateId(): string {
    return this.state.aggregateId;
  }

  get eventType(): string {
    return this.state.eventType;
  }

  get payload(): Readonly<Record<string, unknown>> {
    return this.state.payload;
  }

  get occurredAt(): Date {
    return this.state.occurredAt;
  }

  get attempts(): number {
    return this.state.attempts;
  }

  get permanentFailures(): number {
    return this.state.permanentFailures;
  }

  get nextAttemptAt(): Date {
    return this.state.nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this.state.publishedAt;
  }

  get parkedAt(): Date | undefined {
    return this.state.parkedAt;
  }

  get lastErrorCode(): string | undefined {
    return this.state.lastErrorCode;
  }

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const occurredAt = new Date(event.occurredAt.getTime());
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: { ...event.toJSON() },
      occurredAt,
      attempts: 0,
      permanentFailures: 0,
      nextAttemptAt: new Date(occurredAt.getTime()),
      lockedUntil: undefined,
      lockedBy: undefined,
      publishedAt: undefined,
      parkedAt: undefined,
      lastErrorCode: undefined,
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage({ ...state });
  }

  isPending(): boolean {
    return this.state.publishedAt === undefined;
  }

  isParked(): boolean {
    return this.state.parkedAt !== undefined && this.state.publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this.state.nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    if (this.state.publishedAt !== undefined) {
      throw new InvalidOutboxTransitionError(
        `Outbox message ${this.state.id} is already published`,
      );
    }
    this.state = {
      ...this.state,
      publishedAt: at,
      lockedUntil: undefined,
      lockedBy: undefined,
    };
  }

  scheduleRetry(input: ScheduleRetryInput): void {
    const attempts = this.state.attempts + 1;
    const wasParked = this.state.parkedAt !== undefined;
    const permanentFailures =
      input.kind === 'PERMANENT' ? this.state.permanentFailures + 1 : this.state.permanentFailures;
    const parks = wasParked || permanentFailures >= PARK_AFTER_PERMANENT_FAILURES;
    const parkedAt = parks ? (this.state.parkedAt ?? input.now) : undefined;
    const delayMs = parks ? PARKED_RETRY_MS : OutboxMessage.backoffMs(attempts, input.jitterRatio);
    this.state = {
      ...this.state,
      attempts,
      permanentFailures,
      parkedAt,
      lastErrorCode: input.errorCode,
      nextAttemptAt: new Date(input.now.getTime() + delayMs),
      lockedUntil: undefined,
      lockedBy: undefined,
    };
  }

  requeue(now: Date): void {
    this.state = { ...this.state, nextAttemptAt: now };
  }

  toState(): OutboxMessageState {
    return { ...this.state };
  }

  private static backoffMs(attempts: number, jitterRatio: number): number {
    const baseMs = Math.min(2 ** Math.min(attempts, MAX_BACKOFF_EXPONENT) * 1000, MAX_BACKOFF_MS);
    return baseMs * (1 + jitterRatio);
  }
}
