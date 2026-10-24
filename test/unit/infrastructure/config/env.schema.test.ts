import { hostname } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { loadConfig } from '@infrastructure/config/env.schema';

const databaseUrl = 'postgres://app:secret@localhost:5432/jungle';

describe('loadConfig', () => {
  it('applies the documented defaults', () => {
    const config = loadConfig({ DATABASE_URL: databaseUrl }, { role: 'api' });
    expect(config.SQS_ENDPOINT).toBe('http://localhost:4566');
    expect(config.WAGER_QUEUE_NAME).toBe('wager-transactions.fifo');
    expect(config.WAGER_DLQ_NAME).toBe('wager-transactions-dlq.fifo');
    expect(config.EVENTS_QUEUE_NAME).toBe('wallet-events.fifo');
    expect(config.HTTP_PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.DB_LOCK_TIMEOUT_MS).toBe(3000);
    expect(config.DB_STATEMENT_TIMEOUT_MS).toBe(5000);
    expect(config.DB_TRANSACTION_TIMEOUT_MS).toBe(15000);
    expect(config.DB_POOL_MAX).toBe(20);
    expect(config.RECONCILIATION_QUERY_TIMEOUT_MS).toBe(65000);
    expect(config.CONSUMER_VISIBILITY_HEARTBEAT_MS).toBe(10000);
    expect(config.CONSUMER_VISIBILITY_TIMEOUT_SECONDS).toBe(30);
    expect(config.CONSUMER_MAX_RECEIVE_COUNT).toBe(8);
    expect(config.OUTBOX_BATCH_SIZE).toBe(50);
    expect(config.PENDING_TTL_MS).toBe(900000);
    expect(config.RECONCILIATION_INTERVAL_MS).toBe(300000);
    expect(config.AUTH_AUDIENCE).toBe('wagering-api');
    expect(config.OTEL_ENABLED).toBe(false);
    expect(config.ENABLE_FAULT_INJECTION).toBe(false);
    expect(config.FAULT_POINTS).toEqual([]);
    expect(config.SUPPORTED_CURRENCIES).toEqual(['BRL', 'USD', 'EUR']);
  });

  it('uses the hostname when INSTANCE_ID is absent or empty', () => {
    expect(loadConfig({ DATABASE_URL: databaseUrl }, { role: 'api' }).INSTANCE_ID).toBe(hostname());
    expect(
      loadConfig({ DATABASE_URL: databaseUrl, INSTANCE_ID: '' }, { role: 'api' }).INSTANCE_ID,
    ).toBe(hostname());
  });

  it('treats an empty string as absent for numbers', () => {
    const config = loadConfig({ DATABASE_URL: databaseUrl, HTTP_PORT: '' }, { role: 'api' });
    expect(config.HTTP_PORT).toBe(3000);
  });

  it('coerces integers from strings', () => {
    const config = loadConfig({ DATABASE_URL: databaseUrl, DB_POOL_MAX: '7' }, { role: 'api' });
    expect(config.DB_POOL_MAX).toBe(7);
  });

  it('rejects non-integer numbers', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: databaseUrl, DB_POOL_MAX: '1.5' }, { role: 'api' }),
    ).toThrow('DB_POOL_MAX');
  });

  it('requires DATABASE_URL for service roles', () => {
    for (const role of [
      'api',
      'consumer',
      'outbox',
      'scheduler',
      'events-audit',
      'script',
    ] as const) {
      expect(() => loadConfig({}, { role })).toThrow('DATABASE_URL is required');
    }
    expect(() => loadConfig({ DATABASE_URL: '' }, { role: 'api' })).toThrow(
      'DATABASE_URL is required',
    );
  });

  it('requires MIGRATION_DATABASE_URL only for migrate', () => {
    expect(() => loadConfig({ DATABASE_URL: databaseUrl }, { role: 'migrate' })).toThrow(
      'MIGRATION_DATABASE_URL is required',
    );
    const config = loadConfig({ MIGRATION_DATABASE_URL: databaseUrl }, { role: 'migrate' });
    expect(config.MIGRATION_DATABASE_URL).toBe(databaseUrl);
    expect(
      loadConfig({ DATABASE_URL: databaseUrl }, { role: 'consumer' }).MIGRATION_DATABASE_URL,
    ).toBeUndefined();
  });

  it('parses the currency whitelist into codes', () => {
    const config = loadConfig(
      { DATABASE_URL: databaseUrl, SUPPORTED_CURRENCIES: 'BRL, JPY' },
      { role: 'api' },
    );
    expect(config.SUPPORTED_CURRENCIES).toEqual(['BRL', 'JPY']);
  });

  it('rejects malformed currency codes', () => {
    for (const value of ['brl', 'BRLL', 'BR', 'BRL,US1']) {
      expect(() =>
        loadConfig({ DATABASE_URL: databaseUrl, SUPPORTED_CURRENCIES: value }, { role: 'api' }),
      ).toThrow('SUPPORTED_CURRENCIES');
    }
  });

  it('rejects a heartbeat that is not below half of the visibility timeout', () => {
    expect(() =>
      loadConfig(
        {
          DATABASE_URL: databaseUrl,
          CONSUMER_VISIBILITY_HEARTBEAT_MS: '15000',
          CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '30',
        },
        { role: 'consumer' },
      ),
    ).toThrow('CONSUMER_VISIBILITY_HEARTBEAT_MS');
    const config = loadConfig(
      {
        DATABASE_URL: databaseUrl,
        CONSUMER_VISIBILITY_HEARTBEAT_MS: '14999',
        CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '30',
      },
      { role: 'consumer' },
    );
    expect(config.CONSUMER_VISIBILITY_HEARTBEAT_MS).toBe(14999);
  });

  it('parses fault injection settings', () => {
    const config = loadConfig(
      {
        DATABASE_URL: databaseUrl,
        ENABLE_FAULT_INJECTION: 'true',
        FAULT_POINTS: 'api.before_commit,consumer.before_commit',
      },
      { role: 'api' },
    );
    expect(config.ENABLE_FAULT_INJECTION).toBe(true);
    expect(config.FAULT_POINTS).toEqual(['api.before_commit', 'consumer.before_commit']);
  });
});
