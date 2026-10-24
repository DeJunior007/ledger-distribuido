import { describe, expect, it } from 'bun:test';
import { createLogger } from '@infrastructure/observability/logger';
import { PinoLoggerAdapter } from '@infrastructure/observability/pino-logger.adapter';
import { requestContext } from '@infrastructure/observability/request-context';
import { captureLogs } from './log-capture';

describe('PinoLoggerAdapter', () => {
  it('writes each level with the message, the fields and the context', async () => {
    const capture = captureLogs();
    const adapter = new PinoLoggerAdapter(
      createLogger({ level: 'info', service: 'consumer', instanceId: 'c-1' }, capture.destination),
    );
    await requestContext.run({ messageId: 'msg-1' }, () => {
      adapter.info('message received', { providerId: 'p-1' });
      adapter.warn('retry scheduled', { attempt: 2, reason: 'transient' });
      adapter.error('message failed', { failureCode: 'INVALID_PAYLOAD' });
      adapter.info('no fields');
      return Promise.resolve();
    });
    const entries = capture.entries();
    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({
      level: 30,
      message: 'message received',
      providerId: 'p-1',
      messageId: 'msg-1',
      service: 'consumer',
    });
    expect(entries[1]).toMatchObject({
      level: 40,
      message: 'retry scheduled',
      attempt: 2,
      reason: 'transient',
    });
    expect(entries[2]).toMatchObject({
      level: 50,
      message: 'message failed',
      failureCode: 'INVALID_PAYLOAD',
    });
    expect(entries[3]).toMatchObject({ level: 30, message: 'no fields', messageId: 'msg-1' });
  });
});
