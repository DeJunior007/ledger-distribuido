import { describe, expect, it } from 'bun:test';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import { createLogger, serializeError } from '@infrastructure/observability/logger';
import { requestContext } from '@infrastructure/observability/request-context';
import { captureLogs } from './log-capture';

const settings = { level: 'info', service: 'api', instanceId: 'api-1' } as const;

const SQL_MESSAGE =
  'insert into "ledger_entries" ("wallet_id", "amount") values (\'0192f0c4-7a1e-7000-8000-000000000001\', \'25.00\') - duplicate key value violates unique constraint "ledger_entries_pkey"';

const driverError = (): UniqueConstraintViolationException =>
  new UniqueConstraintViolationException(
    Object.assign(new Error(SQL_MESSAGE), { code: '23505', constraint: 'ledger_entries_pkey' }),
  );

const loggerWithCapture = () => {
  const capture = captureLogs();
  return { capture, logger: createLogger(settings, capture.destination) };
};

describe('createLogger', () => {
  it('writes one JSON line with base fields, ISO time and the message key', () => {
    const { capture, logger } = loggerWithCapture();
    logger.info('wallet created');
    const [entry] = capture.entries();
    expect(capture.lines).toHaveLength(1);
    expect(entry?.message).toBe('wallet created');
    expect(entry?.service).toBe('api');
    expect(entry?.instanceId).toBe('api-1');
    expect(typeof entry?.time).toBe('string');
    expect(new Date(String(entry?.time)).toISOString()).toBe(String(entry?.time));
  });

  it('redacts money, authorization header and request body', () => {
    const { capture, logger } = loggerWithCapture();
    logger.info(
      {
        money: { amount: '25.00' },
        req: { headers: { authorization: 'Bearer secret-token' }, body: { amount: '25.00' } },
      },
      'request received',
    );
    const [line] = capture.lines;
    expect(line).not.toContain('25.00');
    expect(line).not.toContain('secret-token');
    const [entry] = capture.entries();
    expect(entry).toMatchObject({
      money: { amount: '[REDACTED]' },
      req: { headers: { authorization: '[REDACTED]' }, body: '[REDACTED]' },
    });
  });

  it('redacts every monetary path of the spec', () => {
    const { capture, logger } = loggerWithCapture();
    logger.info(
      {
        wallet: {
          money: '1.00',
          balance: '2.00',
          initialBalance: '3.00',
          amount: '4.00',
          balanceBefore: '5.00',
          balanceAfter: '6.00',
          storedBalance: '7.00',
          calculatedBalance: '8.00',
          difference: '9.00',
        },
        req: { headers: { cookie: 'session=abc' } },
        res: { headers: { 'set-cookie': 'session=abc' }, body: { ok: true } },
      },
      'snapshot',
    );
    const [line] = capture.lines;
    for (const value of ['1.00', '2.00', '3.00', '4.00', '5.00', '6.00', '7.00', '8.00', '9.00']) {
      expect(line).not.toContain(value);
    }
    expect(line).not.toContain('session=abc');
    expect(capture.entries()[0]).toMatchObject({ res: { body: '[REDACTED]' } });
  });

  it('adds the request context to each line', async () => {
    const { capture, logger } = loggerWithCapture();
    await requestContext.run({ correlationId: 'corr-1', requestId: 'req-1' }, () => {
      logger.info('first');
      requestContext.enrich({ walletId: 'wallet-1', transactionId: 'tx-1' });
      logger.info('second');
      return Promise.resolve();
    });
    logger.info('outside');
    const [first, second, outside] = capture.entries();
    expect(first).toMatchObject({ correlationId: 'corr-1', requestId: 'req-1' });
    expect(first?.walletId).toBeUndefined();
    expect(second).toMatchObject({
      correlationId: 'corr-1',
      requestId: 'req-1',
      walletId: 'wallet-1',
      transactionId: 'tx-1',
    });
    expect(outside?.correlationId).toBeUndefined();
  });

  it('logs a driver error only with name, code and constraint', () => {
    const { capture, logger } = loggerWithCapture();
    logger.error(driverError());
    logger.error({ err: driverError() });
    logger.error({ err: driverError() }, 'write failed');
    for (const line of capture.lines) {
      expect(line).not.toContain('insert into');
      expect(line).not.toContain('25.00');
      expect(line).not.toContain('0192f0c4');
    }
    const entries = capture.entries();
    for (const entry of entries) {
      expect(entry.err).toEqual({
        name: 'UniqueConstraintViolationException',
        code: '23505',
        constraint: 'ledger_entries_pkey',
      });
    }
    expect(entries.map((entry) => entry.message)).toEqual([
      'UniqueConstraintViolationException',
      'UniqueConstraintViolationException',
      'write failed',
    ]);
  });

  it('logs a technical error caused by a driver error without the driver message', () => {
    const { capture, logger } = loggerWithCapture();
    const error = new TechnicalError(ErrorClass.Race, 'race', { cause: driverError() });
    logger.error(error);
    logger.error({ err: error }, 'transaction failed');
    for (const line of capture.lines) {
      expect(line).not.toContain('insert into');
      expect(line).not.toContain('25.00');
      expect(line).not.toContain('"stack"');
    }
    for (const entry of capture.entries()) {
      expect(entry.err).toEqual({
        name: 'TechnicalError',
        code: '23505',
        constraint: 'ledger_entries_pkey',
        reason: 'race',
      });
    }
  });

  it('logs a raw error with sqlState only with name, code and constraint', () => {
    const { capture, logger } = loggerWithCapture();
    const error = Object.assign(new Error(SQL_MESSAGE), {
      sqlState: '55P03',
      constraint: 'wallets_pkey',
    });
    logger.error({ err: error });
    expect(capture.lines[0]).not.toContain('insert into');
    expect(capture.entries()[0]?.err).toEqual({
      name: 'Error',
      code: '55P03',
      constraint: 'wallets_pkey',
    });
  });

  it('respects the configured level', () => {
    const capture = captureLogs();
    const logger = createLogger({ ...settings, level: 'warn' }, capture.destination);
    logger.info('hidden');
    logger.warn('shown');
    expect(capture.entries().map((entry) => entry.message)).toEqual(['shown']);
  });
});

describe('serializeError', () => {
  it('keeps message and stack of a programming error and serializes its cause safely', () => {
    const serialized = serializeError(new Error('wrapper', { cause: driverError() }));
    expect(serialized).toMatchObject({
      name: 'Error',
      message: 'wrapper',
      cause: {
        name: 'UniqueConstraintViolationException',
        code: '23505',
        constraint: 'ledger_entries_pkey',
      },
    });
    expect(JSON.stringify(serialized)).not.toContain('insert into');
  });

  it('returns values that are not errors unchanged', () => {
    expect(serializeError('plain')).toBe('plain');
  });
});
