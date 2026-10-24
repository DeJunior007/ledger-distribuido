import { describe, expect, it } from 'bun:test';
import {
  READINESS_PROBE_TIMEOUT_MS,
  ReadinessService,
  type ReadinessProbe,
} from '@interfaces/health/readiness.service';

const healthy: ReadinessProbe = () => Promise.resolve();

const failing: ReadinessProbe = () => Promise.reject(new Error('probe failed'));

const delayed =
  (ms: number): ReadinessProbe =>
  () =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });

describe('ReadinessService', () => {
  it('reports ok when both probes succeed', async () => {
    const service = new ReadinessService({ database: healthy, queue: healthy });

    expect(await service.check()).toEqual({
      status: 'ok',
      checks: { database: 'up', queue: 'up' },
    });
  });

  it('marks the database down when its probe fails', async () => {
    const service = new ReadinessService({ database: failing, queue: healthy });

    expect(await service.check()).toEqual({
      status: 'unavailable',
      checks: { database: 'down', queue: 'up' },
    });
  });

  it('marks the queue down when its probe fails', async () => {
    const service = new ReadinessService({ database: healthy, queue: failing });

    expect(await service.check()).toEqual({
      status: 'unavailable',
      checks: { database: 'up', queue: 'down' },
    });
  });

  it('marks a probe down when it throws before returning a promise', async () => {
    const throwing: ReadinessProbe = () => {
      throw new Error('probe crashed');
    };
    const service = new ReadinessService({ database: healthy, queue: throwing });

    expect((await service.check()).checks.queue).toBe('down');
  });

  it('marks a probe down when it takes longer than one second', async () => {
    const service = new ReadinessService({
      database: delayed(READINESS_PROBE_TIMEOUT_MS + 1000),
      queue: healthy,
    });
    const startedAt = performance.now();

    const report = await service.check();

    const elapsed = performance.now() - startedAt;
    expect(report).toEqual({ status: 'unavailable', checks: { database: 'down', queue: 'up' } });
    expect(READINESS_PROBE_TIMEOUT_MS).toBe(1000);
    expect(elapsed).toBeGreaterThanOrEqual(READINESS_PROBE_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(READINESS_PROBE_TIMEOUT_MS + 500);
  });

  it('runs the probes in parallel', async () => {
    const service = new ReadinessService({ database: delayed(600), queue: delayed(600) });
    const startedAt = performance.now();

    const report = await service.check();

    const elapsed = performance.now() - startedAt;
    expect(report.status).toBe('ok');
    expect(elapsed).toBeLessThan(1000);
  });
});
