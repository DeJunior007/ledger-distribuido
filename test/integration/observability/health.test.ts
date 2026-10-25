import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTestApp } from '@test/support/test-app';
import type { TestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';

const SETUP_TIMEOUT_MS = 60_000;

let app: TestApp | undefined;

const get = (path: string): Promise<Response> => {
  if (app === undefined) {
    throw new TypeError('the health test app was not started');
  }
  return fetch(`${app.baseUrl}${path}`);
};

beforeAll(async () => {
  const database = await createTestDatabase();
  app = await createTestApp({ roles: ['api'], env: { DATABASE_URL: database.appUrl } });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await app?.stop();
});

describe('health', () => {
  it('answers live with 200', async () => {
    const response = await get('/health/live');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('answers ready with 200 when the database and the queue are up', async () => {
    const response = await get('/health/ready');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      checks: { database: 'up', queue: 'up' },
    });
  });
});
