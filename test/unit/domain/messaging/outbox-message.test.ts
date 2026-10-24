import { describe, expect, it } from 'bun:test';
import { InvalidOutboxTransitionError } from '@domain/messaging/errors/invalid-outbox-transition.error';
import { IntegrationEvent } from '@domain/messaging/integration-event';
import { OutboxMessage } from '@domain/messaging/outbox-message';

const occurredAt = new Date('2026-01-01T00:00:00.000Z');
const now = new Date('2026-01-01T00:10:00.000Z');
const HOUR_MS = 3_600_000;

class SampleEvent extends IntegrationEvent<{ amount: string }> {
  readonly eventType = 'SampleEvent';
  readonly version = 1;

  static create(): SampleEvent {
    return new SampleEvent({
      eventId: 'event-1',
      aggregateId: 'agg-1',
      correlationId: 'corr-1',
      occurredAt,
      data: { amount: '10.00' },
    });
  }
}

function enqueue(): OutboxMessage {
  return OutboxMessage.enqueue(SampleEvent.create());
}

function retry(
  message: OutboxMessage,
  kind: 'TRANSIENT' | 'PERMANENT',
  jitterRatio = 0,
  at: Date = now,
): void {
  message.scheduleRetry({ now: at, kind, errorCode: 'ERR', jitterRatio });
}

describe('OutboxMessage', () => {
  it('enqueues with zeroed counters and the event as payload', () => {
    const message = enqueue();
    expect(message.id).toBe('event-1');
    expect(message.aggregateId).toBe('agg-1');
    expect(message.eventType).toBe('SampleEvent');
    expect(message.attempts).toBe(0);
    expect(message.permanentFailures).toBe(0);
    expect(message.nextAttemptAt.getTime()).toBe(occurredAt.getTime());
    expect(message.payload.eventId).toBe('event-1');
    expect(message.isPending()).toBe(true);
    expect(message.isParked()).toBe(false);
  });

  it('is due only once nextAttemptAt has been reached', () => {
    const message = enqueue();
    expect(message.isDue(new Date(occurredAt.getTime() - 1))).toBe(false);
    expect(message.isDue(occurredAt)).toBe(true);
  });

  it('backs off transient failures exponentially with jitter', () => {
    const message = enqueue();
    retry(message, 'TRANSIENT');
    expect(message.nextAttemptAt.getTime() - now.getTime()).toBe(2000);
    retry(message, 'TRANSIENT', 0.1);
    expect(message.nextAttemptAt.getTime() - now.getTime()).toBe(4400);
    expect(message.attempts).toBe(2);
    expect(message.lastErrorCode).toBe('ERR');
    expect(message.permanentFailures).toBe(0);
  });

  it('caps the transient backoff at 300 seconds and never gives up', () => {
    const message = enqueue();
    for (let i = 0; i < 50; i += 1) {
      retry(message, 'TRANSIENT', 0.2);
    }
    expect(message.nextAttemptAt.getTime() - now.getTime()).toBe(360_000);
    expect(message.isParked()).toBe(false);
    expect(message.isPending()).toBe(true);
  });

  it('parks on the third permanent failure and retries in one hour', () => {
    const message = enqueue();
    retry(message, 'PERMANENT');
    retry(message, 'PERMANENT');
    expect(message.isParked()).toBe(false);
    retry(message, 'PERMANENT');
    expect(message.isParked()).toBe(true);
    expect(message.parkedAt).toEqual(now);
    expect(message.nextAttemptAt.getTime() - now.getTime()).toBe(HOUR_MS);
  });

  it('keeps retrying a parked message every hour and keeps the first parkedAt', () => {
    const message = enqueue();
    for (let i = 0; i < 3; i += 1) {
      retry(message, 'PERMANENT');
    }
    const later = new Date(now.getTime() + HOUR_MS);
    expect(message.isDue(later)).toBe(true);
    retry(message, 'PERMANENT', 0, later);
    expect(message.parkedAt).toEqual(now);
    expect(message.nextAttemptAt.getTime()).toBe(later.getTime() + HOUR_MS);
    const afterTransient = new Date(later.getTime() + HOUR_MS);
    retry(message, 'TRANSIENT', 0, afterTransient);
    expect(message.nextAttemptAt.getTime()).toBe(afterTransient.getTime() + HOUR_MS);
    expect(message.isDue(new Date(afterTransient.getTime() + HOUR_MS))).toBe(true);
  });

  it('requeue makes a parked message due right away and stays parked', () => {
    const message = enqueue();
    for (let i = 0; i < 3; i += 1) {
      retry(message, 'PERMANENT');
    }
    const requeuedAt = new Date(now.getTime() + 1000);
    expect(message.isDue(requeuedAt)).toBe(false);
    message.requeue(requeuedAt);
    expect(message.isDue(requeuedAt)).toBe(true);
    expect(message.isParked()).toBe(true);
  });

  it('marks published once and rejects a second publication', () => {
    const message = enqueue();
    message.markPublished(now);
    expect(message.publishedAt).toEqual(now);
    expect(message.isPending()).toBe(false);
    expect(message.isParked()).toBe(false);
    expect(message.isDue(now)).toBe(false);
    expect(() => {
      message.markPublished(now);
    }).toThrow(InvalidOutboxTransitionError);
  });

  it('rehydrates from state without altering it', () => {
    const state = enqueue().toState();
    expect(OutboxMessage.rehydrate(state).toState()).toEqual(state);
  });
});
