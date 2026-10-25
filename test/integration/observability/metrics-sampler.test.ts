import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import type { PendingReferenceRetry } from '@application/ports/repositories/pending-reference-repository.port';
import { SchedulerModule } from '@bootstrap/scheduler.module';
import { OutboxMessage } from '@domain/messaging/outbox-message';
import type { OutboxMessageState } from '@domain/messaging/outbox-message';
import { loadConfig } from '@infrastructure/config/env.schema';
import { QueueNames } from '@infrastructure/messaging/queue-names';
import { createLogger } from '@infrastructure/observability/logger';
import { createMetricsRegistry } from '@infrastructure/observability/metrics.registry';
import type { JungleMetrics } from '@infrastructure/observability/metrics.registry';
import { PinoLoggerAdapter } from '@infrastructure/observability/pino-logger.adapter';
import { PromMetricsAdapter } from '@infrastructure/observability/prom-metrics.adapter';
import { MikroOrmUnitOfWork } from '@infrastructure/persistence/mikro-orm-unit-of-work';
import { closeOrmInstances, openOrmInstances } from '@infrastructure/persistence/orm-instances';
import type { OrmInstances } from '@infrastructure/persistence/orm-instances';
import { createTestSqsClient, publishBody } from '@test/support/sqs';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { createTestQueues } from '@test/support/test-queues';
import type { TestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

const SAMPLE_INTERVAL_MS = 1_000;
const SAMPLE_MARGIN_MS = 1_000;
const POLL_INTERVAL_MS = 50;
const WALLET_ID = '0198d000-0000-7000-8000-000000000001';
const PLAYER_ID = '0198d000-0000-7000-8000-000000000002';
const PAST = new Date('2020-01-01T00:00:00.000Z');
const FUTURE = new Date('2100-01-01T00:00:00.000Z');
const STUCK_ATTEMPTS = 10;
const HASH = 'b'.repeat(64);

const INSERT_WALLET = `INSERT INTO wallets (id, player_id, currency, balance, created_at, updated_at)
VALUES ($1, $2, 'BRL', 0, now(), now())`;

const INSERT_PENDING_TRANSACTION = `INSERT INTO wager_transactions (
  id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
  round_id, game_id, kind, amount, currency, reference_external_transaction_id,
  status, failure_code, correlation_id, created_at, updated_at
) VALUES ($1, 'provider-a', $2, $2, $3, $4, $5, 'round-1', 'game-1', 'WIN', 10, 'BRL', 'bet-1',
  'PENDING_REFERENCE', NULL, 'corr-1', now(), now())`;

interface SampledGauges {
  readonly pending: number;
  readonly parked: number;
  readonly stuck: number;
  readonly lagSeconds: number;
  readonly pendingOpen: number;
  readonly dlq: number;
}

const ZERO_GAUGES: SampledGauges = {
  pending: 0,
  parked: 0,
  stuck: 0,
  lagSeconds: 0,
  pendingOpen: 0,
  dlq: 0,
};

const uuidAt = (prefix: string, index: number): string =>
  `0198d000-0000-7000-${prefix}-${String(index).padStart(12, '0')}`;

const outboxState = (
  index: number,
  overrides: Partial<OutboxMessageState> = {},
): OutboxMessageState => ({
  id: uuidAt('8001', index),
  aggregateId: WALLET_ID,
  eventType: 'WalletBalanceChanged',
  payload: { eventId: uuidAt('8001', index), data: { walletId: WALLET_ID } },
  occurredAt: PAST,
  attempts: 0,
  permanentFailures: 0,
  nextAttemptAt: FUTURE,
  lockedUntil: undefined,
  lockedBy: undefined,
  publishedAt: undefined,
  parkedAt: undefined,
  lastErrorCode: undefined,
  ...overrides,
});

const retryFor = (
  index: number,
  overrides: Partial<PendingReferenceRetry> = {},
): PendingReferenceRetry => ({
  transactionId: uuidAt('8002', index),
  attempts: 0,
  consecutiveErrors: 0,
  nextAttemptAt: FUTURE,
  deadlineAt: FUTURE,
  lockedUntil: undefined,
  lockedBy: undefined,
  resolvedAt: undefined,
  createdAt: PAST,
  ...overrides,
});

const singleValue = async (gauge: JungleMetrics['outboxPending']): Promise<number | undefined> =>
  (await gauge.get()).values[0]?.value;

const readGauges = async (metrics: JungleMetrics): Promise<SampledGauges> => {
  const dlq = (await metrics.sqsDlqMessages.get()).values.find(
    (value) => value.labels.queue === QueueNames.WagerTransactionsDlq,
  );
  return {
    pending: (await singleValue(metrics.outboxPending)) ?? -1,
    parked: (await singleValue(metrics.outboxParked)) ?? -1,
    stuck: (await singleValue(metrics.outboxStuck)) ?? -1,
    lagSeconds: (await singleValue(metrics.outboxLag)) ?? -1,
    pendingOpen: (await singleValue(metrics.pendingReferenceOpen)) ?? -1,
    dlq: dlq?.value ?? -1,
  };
};

const resetGauges = (metrics: JungleMetrics): void => {
  for (const gauge of [
    metrics.outboxPending,
    metrics.outboxParked,
    metrics.outboxStuck,
    metrics.outboxLag,
    metrics.pendingReferenceOpen,
  ]) {
    gauge.set(-1);
  }
  metrics.sqsDlqMessages.set({ queue: QueueNames.WagerTransactionsDlq }, -1);
};

describe('MetricsSamplerWorker in the scheduler module', () => {
  const metricsRegistry = createMetricsRegistry();
  const metrics = metricsRegistry.metrics;
  let database: TestDatabase;
  let queues: TestQueues;
  let instances: OrmInstances;
  let uow: MikroOrmUnitOfWork;
  let sqs: SQSClient;
  let client: Client;
  let app: INestApplicationContext;
  let observed: SampledGauges;

  const gaugesMatch = async (expected: (gauges: SampledGauges) => boolean): Promise<boolean> => {
    observed = await readGauges(metrics);
    return expected(observed);
  };

  beforeEach(async () => {
    resetGauges(metrics);
    database = await createTestDatabase();
    queues = await createTestQueues();
    const config = loadConfig(
      {
        DATABASE_URL: database.appUrl,
        WAGER_DLQ_NAME: queues.names.wagerTransactionsDlq,
        METRICS_SAMPLE_INTERVAL_MS: String(SAMPLE_INTERVAL_MS),
      },
      { role: 'scheduler' },
    );
    instances = await openOrmInstances(config);
    uow = new MikroOrmUnitOfWork(instances, config);
    sqs = createTestSqsClient();
    client = new Client({ connectionString: database.appUrl });
    await client.connect();
    await client.query(INSERT_WALLET, [WALLET_ID, PLAYER_ID]);
    const orm = instances;
    const queueClient = sqs;
    app = await NestFactory.createApplicationContext(
      SchedulerModule.register({
        config,
        orm,
        probes: {
          database: async (): Promise<void> => {
            await orm.main.em.fork().execute('select 1');
          },
          queue: () => Promise.resolve(),
        },
        sqs: queueClient,
        dlqUrl: queues.urls.wagerTransactionsDlq,
        logger: new PinoLoggerAdapter(
          createLogger({ level: 'silent', service: 'scheduler', instanceId: config.INSTANCE_ID }),
        ),
        metrics: new PromMetricsAdapter(metrics),
        closeResources: async (): Promise<void> => {
          queueClient.destroy();
          await closeOrmInstances(orm);
        },
      }),
      { logger: false },
    );
  });

  afterEach(async () => {
    await client.end();
    await app.close();
  });

  const enqueueOutbox = (...states: OutboxMessageState[]): Promise<void> =>
    uow.run('short', async (repos) => {
      for (const state of states) {
        repos.outbox.enqueue(OutboxMessage.rehydrate(state));
      }
      await repos.flush();
    });

  const seedPendingReferences = async (...retries: PendingReferenceRetry[]): Promise<void> => {
    for (const retry of retries) {
      await client.query(INSERT_PENDING_TRANSACTION, [
        retry.transactionId,
        `win-${retry.transactionId}`,
        HASH,
        WALLET_ID,
        PLAYER_ID,
      ]);
    }
    await uow.run('short', async (repos) => {
      for (const retry of retries) {
        repos.pendingReferences.insert(retry);
      }
      await repos.flush();
    });
  };

  const databaseNow = async (): Promise<Date> => {
    const result = await client.query<{ now: Date }>('SELECT now() AS now');
    return result.rows[0]?.now ?? PAST;
  };

  it('reports zero gauges right after boot when nothing is pending', async () => {
    await waitFor(() => gaugesMatch((gauges) => gauges.pending === 0 && gauges.dlq === 0), {
      timeoutMs: SAMPLE_INTERVAL_MS + SAMPLE_MARGIN_MS,
      intervalMs: POLL_INTERVAL_MS,
    });

    expect(observed).toEqual(ZERO_GAUGES);
  });

  it('reflects pending, parked and stuck events, open pending references and the dlq depth within one cycle', async () => {
    await waitFor(() => gaugesMatch((gauges) => gauges.pending === 0 && gauges.dlq === 0), {
      timeoutMs: SAMPLE_INTERVAL_MS + SAMPLE_MARGIN_MS,
      intervalMs: POLL_INTERVAL_MS,
    });
    const now = await databaseNow();
    await enqueueOutbox(
      outboxState(1, { occurredAt: new Date(now.getTime() - 120_000) }),
      outboxState(2, { occurredAt: new Date(now.getTime() - 60_000), attempts: STUCK_ATTEMPTS }),
      outboxState(3, { parkedAt: PAST }),
      outboxState(4, { publishedAt: PAST }),
    );
    await seedPendingReferences(retryFor(1), retryFor(2), retryFor(3, { resolvedAt: PAST }));
    await publishBody(sqs, queues.urls.wagerTransactionsDlq, '{"dead":true}', {
      groupId: WALLET_ID,
      deduplicationId: 'dlq-message-1',
    });

    await waitFor(
      () =>
        gaugesMatch(
          (gauges) =>
            gauges.pending === 2 &&
            gauges.parked === 1 &&
            gauges.stuck === 1 &&
            gauges.pendingOpen === 2 &&
            gauges.dlq === 1,
        ),
      { timeoutMs: SAMPLE_INTERVAL_MS + SAMPLE_MARGIN_MS, intervalMs: POLL_INTERVAL_MS },
    );

    expect(observed).toMatchObject({ pending: 2, parked: 1, stuck: 1, pendingOpen: 2, dlq: 1 });
    expect(observed.lagSeconds).toBeGreaterThanOrEqual(120);
    expect(observed.lagSeconds).toBeLessThan(180);
  });
});
