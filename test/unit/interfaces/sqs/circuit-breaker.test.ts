import { describe, expect, it } from 'bun:test';
import { LoggerPort } from '@application/ports/logger.port';
import type { LogFields } from '@application/ports/logger.port';
import { createMetricsRegistry } from '@infrastructure/observability/metrics.registry';
import { PromMetricsAdapter } from '@infrastructure/observability/prom-metrics.adapter';
import { CircuitBreaker } from '@interfaces/sqs/circuit-breaker';
import type { BreakerComponent, BreakerProbe } from '@interfaces/sqs/circuit-breaker';
import { sampleValue } from '../../infrastructure/observability/metric-values';

const { registry, metrics } = createMetricsRegistry();

interface LogEntry {
  readonly level: 'info' | 'warn' | 'error';
  readonly message: string;
  readonly fields: LogFields | undefined;
}

class RecordingLogger extends LoggerPort {
  readonly entries: LogEntry[] = [];

  info(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'info', message, fields });
  }

  warn(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'warn', message, fields });
  }

  error(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'error', message, fields });
  }
}

interface PendingSleep {
  readonly ms: number;
  readonly resolve: () => void;
}

class ManualSleep {
  readonly requested: number[] = [];
  private readonly pending: PendingSleep[] = [];

  readonly sleep = (ms: number): Promise<void> => {
    const { promise, resolve }: PromiseWithResolvers<void> = Promise.withResolvers();
    this.requested.push(ms);
    this.pending.push({ ms, resolve });
    return promise;
  };

  latest(): number | undefined {
    return this.pending.at(-1)?.ms;
  }

  async releaseLatest(): Promise<void> {
    const current = this.pending.pop();
    if (current === undefined) {
      throw new Error('no pending sleep to release');
    }
    current.resolve();
    await settle();
  }
}

type ProbeBehavior = 'pass' | 'fail' | 'hang';

class FakeProbe {
  behavior: ProbeBehavior;
  calls = 0;

  constructor(behavior: ProbeBehavior) {
    this.behavior = behavior;
  }

  readonly run = (): Promise<void> => {
    this.calls += 1;
    if (this.behavior === 'pass') {
      return Promise.resolve();
    }
    if (this.behavior === 'fail') {
      return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
    }
    return new Promise<void>(() => undefined);
  };
}

const settle = async (): Promise<void> => {
  for (let round = 0; round < 5; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

const gauge = (component: BreakerComponent): Promise<number> =>
  sampleValue(registry, 'jungle_circuit_breaker_open', { component });

const buildBreaker = (
  component: BreakerComponent,
  behaviors: Partial<Record<BreakerProbe, ProbeBehavior>> = {},
) => {
  const database = new FakeProbe(behaviors.database ?? 'fail');
  const queue = new FakeProbe(behaviors.queue ?? 'fail');
  const clock = new ManualSleep();
  const logger = new RecordingLogger();
  const breaker = new CircuitBreaker(
    component,
    { database: database.run, queue: queue.run },
    new PromMetricsAdapter(metrics),
    logger,
    clock.sleep,
  );
  return { breaker, database, queue, clock, logger };
};

const trackClosed = (breaker: CircuitBreaker, signal: AbortSignal): { done: boolean } => {
  const tracker = { done: false };
  void breaker.waitUntilClosed(signal).then(() => {
    tracker.done = true;
  });
  return tracker;
};

describe('CircuitBreaker', () => {
  it('starts closed with the gauge at zero', async () => {
    const { breaker } = buildBreaker('consumer');
    expect(breaker.isOpen()).toBe(false);
    expect(await gauge('consumer')).toBe(0);
  });

  it('open turns the gauge on and waits 1 s before the first probe', async () => {
    const { breaker, database, clock, logger } = buildBreaker('consumer');
    breaker.open('database');
    await settle();
    expect(breaker.isOpen()).toBe(true);
    expect(await gauge('consumer')).toBe(1);
    expect(clock.requested).toEqual([1_000]);
    expect(database.calls).toBe(0);
    expect(logger.entries).toContainEqual({
      level: 'warn',
      message: 'circuit breaker opened',
      fields: { component: 'consumer', reason: 'database' },
    });
  });

  it('runs each probe with a 1 s timeout', async () => {
    const { breaker, database, clock } = buildBreaker('outbox');
    breaker.open('database');
    await clock.releaseLatest();
    expect(database.calls).toBe(1);
    expect(clock.requested).toEqual([1_000, 1_000, 2_000]);
  });

  it('backs off 1 s, 2 s, 4 s up to 30 s while the probe keeps failing', async () => {
    const { breaker, database, clock } = buildBreaker('outbox');
    breaker.open('database');
    const waits: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const wait = clock.latest();
      if (wait === undefined) {
        throw new Error('the breaker stopped probing');
      }
      waits.push(wait);
      await clock.releaseLatest();
    }
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    expect(database.calls).toBe(8);
    expect(breaker.isOpen()).toBe(true);
    expect(await gauge('outbox')).toBe(1);
  });

  it('treats a probe that does not answer within the timeout as failed', async () => {
    const { breaker, database, clock, logger } = buildBreaker('scheduler', { database: 'hang' });
    breaker.open('database');
    await clock.releaseLatest();
    expect(database.calls).toBe(1);
    expect(clock.latest()).toBe(1_000);
    await clock.releaseLatest();
    expect(breaker.isOpen()).toBe(true);
    expect(clock.latest()).toBe(2_000);
    expect(logger.entries).toContainEqual({
      level: 'warn',
      message: 'circuit breaker probe failed',
      fields: { component: 'scheduler', reason: 'database', attempt: 1 },
    });
  });

  it('closes, resets the gauge and logs info when the probe passes', async () => {
    const { breaker, database, clock, logger } = buildBreaker('scheduler');
    breaker.open('database');
    const closed = trackClosed(breaker, new AbortController().signal);
    await clock.releaseLatest();
    expect(breaker.isOpen()).toBe(true);
    expect(closed.done).toBe(false);
    database.behavior = 'pass';
    await clock.releaseLatest();
    expect(breaker.isOpen()).toBe(false);
    expect(closed.done).toBe(true);
    expect(await gauge('scheduler')).toBe(0);
    expect(logger.entries).toContainEqual({
      level: 'info',
      message: 'circuit breaker closed',
      fields: { component: 'scheduler', reason: 'database' },
    });
  });

  it('probes only the dependency that failed', async () => {
    const { breaker, database, queue, clock } = buildBreaker('events-audit', { queue: 'pass' });
    breaker.open('queue');
    await clock.releaseLatest();
    expect(queue.calls).toBe(1);
    expect(database.calls).toBe(0);
    expect(breaker.isOpen()).toBe(false);
    expect(await gauge('events-audit')).toBe(0);
  });

  it('does not restart the wait when open is called while already open', async () => {
    const { breaker, database, queue, clock, logger } = buildBreaker('consumer');
    breaker.open('database');
    await clock.releaseLatest();
    expect(clock.latest()).toBe(2_000);
    const requestedBefore = clock.requested.length;
    breaker.open('database');
    breaker.open('queue');
    await settle();
    expect(clock.requested.length).toBe(requestedBefore);
    expect(clock.latest()).toBe(2_000);
    expect(queue.calls).toBe(0);
    expect(database.calls).toBe(1);
    expect(
      logger.entries.filter((entry) => entry.message === 'circuit breaker opened'),
    ).toHaveLength(1);
  });

  it('starts a new cycle from 1 s when opened again after closing', async () => {
    const { breaker, clock } = buildBreaker('outbox', { queue: 'pass' });
    breaker.open('queue');
    await clock.releaseLatest();
    expect(breaker.isOpen()).toBe(false);
    breaker.open('queue');
    await settle();
    expect(breaker.isOpen()).toBe(true);
    expect(clock.latest()).toBe(1_000);
    expect(await gauge('outbox')).toBe(1);
  });

  it('waitUntilClosed resolves at once when the breaker is closed', async () => {
    const { breaker } = buildBreaker('consumer');
    const closed = trackClosed(breaker, new AbortController().signal);
    await settle();
    expect(closed.done).toBe(true);
  });

  it('waitUntilClosed returns when the signal aborts while the breaker is open', async () => {
    const { breaker } = buildBreaker('events-audit');
    breaker.open('queue');
    const controller = new AbortController();
    const closed = trackClosed(breaker, controller.signal);
    await settle();
    expect(closed.done).toBe(false);
    controller.abort();
    await settle();
    expect(closed.done).toBe(true);
    expect(breaker.isOpen()).toBe(true);
  });

  it('waitUntilClosed returns at once for a signal that is already aborted', async () => {
    const { breaker } = buildBreaker('scheduler');
    breaker.open('database');
    const closed = trackClosed(breaker, AbortSignal.abort());
    await settle();
    expect(closed.done).toBe(true);
    expect(breaker.isOpen()).toBe(true);
  });
});
