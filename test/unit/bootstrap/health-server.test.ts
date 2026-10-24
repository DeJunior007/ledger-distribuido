import { afterEach, describe, expect, it } from 'bun:test';
import { startHealthServer, type HealthServer } from '@bootstrap/health-server';
import type { ReadinessProbe } from '@interfaces/health/readiness.service';

const healthy: ReadinessProbe = () => Promise.resolve();

const failing: ReadinessProbe = () => Promise.reject(new Error('probe failed'));

const servers: HealthServer[] = [];

const start = async (database: ReadinessProbe, queue: ReadinessProbe): Promise<HealthServer> => {
  const server = await startHealthServer({ port: 0, probes: { database, queue } });
  servers.push(server);
  return server;
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('startHealthServer', () => {
  it('answers live with 200 on a random port', async () => {
    const server = await start(healthy, healthy);

    const response = await fetch(`${server.url}/health/live`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('answers ready with 200 when both probes succeed', async () => {
    const server = await start(healthy, healthy);

    const response = await fetch(`${server.url}/health/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      checks: { database: 'up', queue: 'up' },
    });
  });

  it('answers ready with 503 when a probe fails', async () => {
    const server = await start(healthy, failing);

    const response = await fetch(`${server.url}/health/ready`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: 'unavailable',
      checks: { database: 'up', queue: 'down' },
    });
  });

  it('keeps live at 200 while ready is unavailable', async () => {
    const server = await start(failing, failing);

    const live = await fetch(`${server.url}/health/live`);
    const ready = await fetch(`${server.url}/health/ready`);

    expect(live.status).toBe(200);
    expect(ready.status).toBe(503);
  });

  it('exposes the process metrics registry', async () => {
    const server = await start(healthy, healthy);

    const response = await fetch(`${server.url}/metrics`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    const body = await response.text();
    expect(body).toContain('# TYPE jungle_wager_transactions_total counter');
    expect(body).toContain('jungle_process_resident_memory_bytes');
  });
});
