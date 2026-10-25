import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it } from 'bun:test';
import { accessLogLevel } from '@infrastructure/observability/logger.module';

const exchangeWith = (statusCode: number): [IncomingMessage, ServerResponse] => {
  const request = new IncomingMessage(new Socket());
  const response = new ServerResponse(request);
  response.statusCode = statusCode;
  return [request, response];
};

const levelOf = (statusCode: number, error?: Error): string => {
  const [request, response] = exchangeWith(statusCode);
  return accessLogLevel(request, response, error);
};

describe('accessLogLevel', () => {
  it('logs successful responses at info', () => {
    expect(levelOf(200)).toBe('info');
    expect(levelOf(201)).toBe('info');
    expect(levelOf(304)).toBe('info');
  });

  it('logs a not found lookup at info', () => {
    expect(levelOf(404)).toBe('info');
  });

  it('keeps the other client errors at warn', () => {
    for (const statusCode of [400, 401, 403, 409, 413, 415, 422, 429]) {
      expect(levelOf(statusCode)).toBe('warn');
    }
  });

  it('keeps server errors at error', () => {
    for (const statusCode of [500, 502, 503, 504]) {
      expect(levelOf(statusCode)).toBe('error');
    }
  });

  it('logs a failed response at error even with a not found status', () => {
    expect(levelOf(404, new Error('socket closed'))).toBe('error');
  });
});
