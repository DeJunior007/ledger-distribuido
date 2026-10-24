import { describe, expect, it } from 'bun:test';
import { EventPublisherPort, type PublishOutcome } from '@application/ports/event-publisher.port';
import { PublishOutboxBatchUseCase } from '@application/use-cases/publish-outbox-batch.use-case';
import type { OutboxMessage, OutboxMessageState } from '@domain/messaging/outbox-message';
import { FakeFaultInjector, InjectedFaultError } from '@test/support/fakes/fault-injector.fake';
import { InMemoryUnitOfWork } from '@test/support/fakes/in-memory-unit-of-work.fake';
import { FakeLogger } from '@test/support/fakes/logger.fake';
import { FakeMetrics } from '@test/support/fakes/metrics.fake';
import { FixedClock } from '@test/support/fixed-clock';
import { at, rejection } from './fixtures';

const LEASE_MS = 30_000;
const INSTANCE_ID = 'instance-1';

type Decide = (message: OutboxMessage) => PublishOutcome;

class ScriptedPublisher extends EventPublisherPort {
  readonly published: string[] = [];
  decide: Decide = (message) => ({ id: message.id, result: 'published' });
  connectivityFailure = false;
  duringPublish: () => Promise<void> = () => Promise.resolve();

  async publishBatch(
    messages: OutboxMessage[],
  ): Promise<{ outcomes: PublishOutcome[]; connectivityFailure: boolean }> {
    this.published.push(...messages.map((message) => message.id));
    await this.duringPublish();
    return {
      outcomes: messages.map((message) => this.decide(message)),
      connectivityFailure: this.connectivityFailure,
    };
  }
}

const failWith =
  (kind: 'TRANSIENT' | 'PERMANENT', errorCode: string): Decide =>
  (message) => ({ id: message.id, result: 'failed', kind, errorCode });

const outboxRow = (id: string, occurredAt = at): OutboxMessageState => ({
  id,
  aggregateId: 'wallet-1',
  eventType: 'WalletBalanceChanged',
  payload: { eventId: id },
  occurredAt,
  attempts: 0,
  permanentFailures: 0,
  nextAttemptAt: occurredAt,
  lockedUntil: undefined,
  lockedBy: undefined,
  publishedAt: undefined,
  parkedAt: undefined,
  lastErrorCode: undefined,
});

const setup = (batchSize = 50) => {
  const clock = new FixedClock(at);
  const uow = new InMemoryUnitOfWork(clock);
  const publisher = new ScriptedPublisher();
  const faults = new FakeFaultInjector();
  const metrics = new FakeMetrics();
  const logger = new FakeLogger();
  const useCase = new PublishOutboxBatchUseCase(uow, publisher, clock, faults, metrics, logger, {
    instanceId: INSTANCE_ID,
    leaseMs: LEASE_MS,
    batchSize,
  });
  const row = (id: string): OutboxMessageState | undefined => uow.database.outbox.get(id);
  return { clock, uow, publisher, faults, metrics, logger, useCase, row };
};

describe('PublishOutboxBatchUseCase', () => {
  it('returns an empty result without touching the publisher when nothing is due', async () => {
    const { useCase, faults, publisher } = setup();

    expect(await useCase.execute()).toStrictEqual({
      claimed: 0,
      full: false,
      connectivityFailure: false,
    });
    expect(faults.hits).toStrictEqual([]);
    expect(publisher.published).toStrictEqual([]);
  });

  it('marks published events and records the publish metrics', async () => {
    const { uow, clock, useCase, metrics, faults, row } = setup();
    uow.database.outbox.put(outboxRow('event-1'));
    uow.database.outbox.put(outboxRow('event-2'));
    clock.advance(1500);

    expect(await useCase.execute()).toStrictEqual({
      claimed: 2,
      full: false,
      connectivityFailure: false,
    });
    expect(row('event-1')?.publishedAt).toStrictEqual(new Date(at.getTime() + 1500));
    expect(row('event-1')?.lockedBy).toBeUndefined();
    expect(row('event-2')?.publishedAt).toStrictEqual(new Date(at.getTime() + 1500));
    expect(metrics.counter('outbox_publish_total', { result: 'published' })).toBe(2);
    expect(metrics.observations('outbox_publish_latency_seconds')).toStrictEqual([1.5, 1.5]);
    expect(faults.hits).toStrictEqual([
      'outbox.after_claim_before_publish',
      'outbox.after_publish_before_mark',
    ]);
  });

  it('reports a full batch when the claim reaches the batch size', async () => {
    const { uow, useCase, row } = setup(2);
    uow.database.outbox.put(outboxRow('event-1'));
    uow.database.outbox.put(outboxRow('event-2'));
    uow.database.outbox.put(outboxRow('event-3'));

    expect(await useCase.execute()).toStrictEqual({
      claimed: 2,
      full: true,
      connectivityFailure: false,
    });
    expect(row('event-3')?.publishedAt).toBeUndefined();
  });

  it('passes the connectivity failure of the publisher through', async () => {
    const { uow, useCase, publisher, metrics, row } = setup();
    uow.database.outbox.put(outboxRow('event-1'));
    publisher.connectivityFailure = true;
    publisher.decide = failWith('TRANSIENT', 'NetworkingError');

    expect(await useCase.execute()).toStrictEqual({
      claimed: 1,
      full: false,
      connectivityFailure: true,
    });
    expect(row('event-1')?.lastErrorCode).toBe('NetworkingError');
    expect(metrics.counter('outbox_publish_total', { result: 'transient' })).toBe(1);
  });

  it('schedules a backoff retry with jitter after a transient failure', async () => {
    const { uow, useCase, publisher, row } = setup();
    uow.database.outbox.put(outboxRow('event-1'));
    publisher.decide = failWith('TRANSIENT', 'ServiceUnavailable');

    await useCase.execute();

    const retried = row('event-1');
    const delayMs = (retried?.nextAttemptAt.getTime() ?? 0) - at.getTime();
    expect(retried?.attempts).toBe(1);
    expect(retried?.permanentFailures).toBe(0);
    expect(retried?.parkedAt).toBeUndefined();
    expect(retried?.publishedAt).toBeUndefined();
    expect(retried?.lockedBy).toBeUndefined();
    expect(retried?.lockedUntil).toBeUndefined();
    expect(delayMs).toBeGreaterThanOrEqual(2000);
    expect(delayMs).toBeLessThanOrEqual(2400);
  });

  it('parks the event on the third permanent failure', async () => {
    const { uow, clock, useCase, publisher, metrics, row } = setup();
    uow.database.outbox.put(outboxRow('event-1'));
    publisher.decide = failWith('PERMANENT', 'InvalidParameterValue');

    await useCase.execute();
    expect(row('event-1')?.parkedAt).toBeUndefined();
    clock.set(row('event-1')?.nextAttemptAt ?? at);
    await useCase.execute();
    expect(row('event-1')?.parkedAt).toBeUndefined();
    clock.set(row('event-1')?.nextAttemptAt ?? at);
    await useCase.execute();

    const parked = row('event-1');
    expect(parked?.permanentFailures).toBe(3);
    expect(parked?.attempts).toBe(3);
    expect(parked?.parkedAt).toStrictEqual(clock.now());
    expect(parked?.nextAttemptAt).toStrictEqual(new Date(clock.now().getTime() + 3_600_000));
    expect(metrics.counter('outbox_publish_total', { result: 'permanent' })).toBe(3);
  });

  it('only logs a warning when another instance took the lease during the publish', async () => {
    const { uow, clock, useCase, publisher, metrics, logger, row } = setup();
    uow.database.outbox.put(outboxRow('event-1'));
    publisher.duringPublish = async () => {
      clock.advance(LEASE_MS + 1);
      await uow.run('short', (repos) =>
        repos.outbox.claimDue({ instanceId: 'instance-2', leaseMs: LEASE_MS, limit: 10 }),
      );
    };

    expect(await useCase.execute()).toStrictEqual({
      claimed: 1,
      full: false,
      connectivityFailure: false,
    });
    expect(row('event-1')?.publishedAt).toBeUndefined();
    expect(row('event-1')?.lockedBy).toBe('instance-2');
    expect(metrics.observations('outbox_publish_latency_seconds')).toStrictEqual([]);
    expect(logger.entriesAt('warn').map((entry) => entry.fields.eventId)).toStrictEqual([
      'event-1',
    ]);
    expect(logger.entriesAt('error')).toStrictEqual([]);
  });

  it('keeps a lost retry schedule away from the row leased by another instance', async () => {
    const { uow, clock, useCase, publisher, logger, row } = setup();
    uow.database.outbox.put(outboxRow('event-1'));
    publisher.decide = failWith('TRANSIENT', 'ServiceUnavailable');
    publisher.duringPublish = async () => {
      clock.advance(LEASE_MS + 1);
      await uow.run('short', (repos) =>
        repos.outbox.claimDue({ instanceId: 'instance-2', leaseMs: LEASE_MS, limit: 10 }),
      );
    };

    await useCase.execute();

    expect(row('event-1')?.attempts).toBe(0);
    expect(row('event-1')?.lockedBy).toBe('instance-2');
    expect(logger.entriesAt('warn')).toHaveLength(1);
  });

  it('stops before publishing when the fault after the claim fires', async () => {
    const { uow, useCase, publisher, faults, row } = setup();
    uow.database.outbox.put(outboxRow('event-1'));
    faults.arm('outbox.after_claim_before_publish');

    expect(await rejection(useCase.execute())).toBeInstanceOf(InjectedFaultError);
    expect(publisher.published).toStrictEqual([]);
    expect(row('event-1')?.lockedBy).toBe(INSTANCE_ID);
    expect(row('event-1')?.publishedAt).toBeUndefined();
  });

  it('republishes after the lease expires when the fault after the publish fires', async () => {
    const { uow, clock, useCase, publisher, faults, row } = setup();
    uow.database.outbox.put(outboxRow('event-1'));
    faults.arm('outbox.after_publish_before_mark');

    expect(await rejection(useCase.execute())).toBeInstanceOf(InjectedFaultError);
    expect(row('event-1')?.publishedAt).toBeUndefined();
    expect(row('event-1')?.lockedBy).toBe(INSTANCE_ID);

    expect((await useCase.execute()).claimed).toBe(0);
    clock.advance(LEASE_MS + 1);
    expect((await useCase.execute()).claimed).toBe(1);
    expect(publisher.published).toStrictEqual(['event-1', 'event-1']);
    expect(row('event-1')?.publishedAt).toStrictEqual(clock.now());
  });
});
