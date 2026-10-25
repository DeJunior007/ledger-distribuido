import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTestApp } from '@test/support/test-app';
import type { TestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let database: TestDatabase;
let app: TestApp;
let operatorToken: string;

const getWithCorrelation = (correlationId: string | null, token: string | null = operatorToken) =>
  fetch(`${app.baseUrl}/wallets/not-a-uuid`, {
    headers: {
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      ...(correlationId === null ? {} : { 'X-Correlation-Id': correlationId }),
    },
  });

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ roles: ['api'], env: { DATABASE_URL: database.appUrl } });
  operatorToken = await app.issuer.token({ role: 'operator' });
});

afterAll(async () => {
  await app.stop();
});

describe('correlation headers', () => {
  it('generates a UUIDv7 request id and reuses it as correlation id', async () => {
    const response = await getWithCorrelation(null);
    const requestId = response.headers.get('x-request-id');
    expect(requestId).toMatch(UUID_V7);
    expect(response.headers.get('x-correlation-id')).toBe(requestId);
  });

  it('generates a different request id for every request', async () => {
    const first = await getWithCorrelation(null);
    const second = await getWithCorrelation(null);
    expect(first.headers.get('x-request-id')).not.toBe(second.headers.get('x-request-id'));
  });

  it('echoes an accepted correlation id and keeps the request id generated', async () => {
    const response = await getWithCorrelation('client-corr-123');
    expect(response.headers.get('x-correlation-id')).toBe('client-corr-123');
    expect(response.headers.get('x-request-id')).toMatch(UUID_V7);
  });

  it('accepts a correlation id of 128 printable characters', async () => {
    const correlationId = 'c'.repeat(128);
    const response = await getWithCorrelation(correlationId);
    expect(response.headers.get('x-correlation-id')).toBe(correlationId);
  });

  it('replaces a correlation id longer than 128 characters with the request id', async () => {
    const response = await getWithCorrelation('c'.repeat(129));
    const requestId = response.headers.get('x-request-id');
    expect(requestId).toMatch(UUID_V7);
    expect(response.headers.get('x-correlation-id')).toBe(requestId);
  });

  it('replaces a correlation id with a space with the request id', async () => {
    const response = await getWithCorrelation('has space');
    const requestId = response.headers.get('x-request-id');
    expect(response.headers.get('x-correlation-id')).toBe(requestId);
  });

  it('ignores a client supplied X-Request-Id', async () => {
    const response = await fetch(`${app.baseUrl}/wallets/not-a-uuid`, {
      headers: { Authorization: `Bearer ${operatorToken}`, 'X-Request-Id': 'client-request' },
    });
    expect(response.headers.get('x-request-id')).toMatch(UUID_V7);
    expect(response.headers.get('x-request-id')).not.toBe('client-request');
  });

  it('returns the headers on a 401', async () => {
    const response = await getWithCorrelation('corr-401', null);
    expect(response.status).toBe(401);
    expect(response.headers.get('x-correlation-id')).toBe('corr-401');
    expect(response.headers.get('x-request-id')).toMatch(UUID_V7);
  });

  it('returns the headers on a 404 for an unknown route', async () => {
    const response = await fetch(`${app.baseUrl}/nowhere`, {
      headers: { 'X-Correlation-Id': 'corr-404' },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get('x-correlation-id')).toBe('corr-404');
    expect(response.headers.get('x-request-id')).toMatch(UUID_V7);
  });

  it('returns the headers on a 400 for malformed JSON', async () => {
    const response = await fetch(`${app.baseUrl}/wallets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${operatorToken}`,
        'Content-Type': 'application/json',
        'X-Correlation-Id': 'corr-400',
      },
      body: '{broken',
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('x-correlation-id')).toBe('corr-400');
    expect(response.headers.get('x-request-id')).toMatch(UUID_V7);
  });

  it('returns the headers on a 200', async () => {
    const response = await fetch(`${app.baseUrl}/wallets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${operatorToken}`,
        'Content-Type': 'application/json',
        'X-Correlation-Id': 'corr-201',
      },
      body: JSON.stringify({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '1.00', currency: 'BRL' },
      }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('x-correlation-id')).toBe('corr-201');
    expect(response.headers.get('x-request-id')).toMatch(UUID_V7);
  });
});
