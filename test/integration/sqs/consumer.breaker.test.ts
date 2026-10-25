import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { createMetricsRegistry } from '@infrastructure/observability/metrics.registry';
import { CONSUMER_COMPONENT } from '@interfaces/sqs/wager-transaction.consumer';
import { pause, unpause } from '@test/support/containers';
import { betCommand, createWalletViaUseCase, toMessageData } from '@test/support/fixtures';
import { buildEnvelope, countMessages, peekMessages, publishEnvelope } from '@test/support/sqs';
import { createTestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

const WAIT = { timeoutMs: 60_000, intervalMs: 200 } as const;
const STEADY_WINDOW_MS = 6_000;
const STEADY_POLL = { timeoutMs: STEADY_WINDOW_MS + 10_000, intervalMs: 250 } as const;
const TEST_TIMEOUT_MS = 180_000;

class QueueNotSteadyError extends Error {
  constructor(detail: string) {
    super(`queue changed while the breaker was open: ${detail}`);
    this.name = 'QueueNotSteadyError';
  }
}

const breakerGauge = async (): Promise<number> => {
  const metric = createMetricsRegistry().registry.getSingleMetric('jungle_circuit_breaker_open');
  if (metric === undefined) {
    throw new TypeError('circuit breaker metric is not registered');
  }
  const data = await metric.get();
  return data.values.find((sample) => sample.labels.component === CONSUMER_COMPONENT)?.value ?? 0;
};

const processedCount = async (databaseUrl: string, externalIds: readonly string[]) => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{ processed: number }>(
      `select count(*)::int as processed from wager_transactions
        where provider_id = $1 and external_transaction_id = any($2::text[])
          and status = 'PROCESSED'`,
      [TEST_PROVIDER_ID, [...externalIds]],
    );
    return result.rows[0]?.processed ?? 0;
  } finally {
    await client.end();
  }
};

describe('wager transaction consumer circuit breaker', () => {
  it(
    'opens on a paused database, stops receiving and processes again once it is back',
    async () => {
      const database = await createTestDatabase();
      const queues = await createTestQueues();
      const app = await createTestApp({
        roles: ['consumer'],
        env: { DATABASE_URL: database.appUrl, ...queues.env },
      });
      const queueUrl = app.queueUrls.wagerTransactions;
      let paused = false;
      try {
        const first = await createWalletViaUseCase(app);
        const second = await createWalletViaUseCase(app);
        const inFlight = betCommand({ wallet: first });
        const waiting = betCommand({ wallet: second });
        const inFlightEnvelope = buildEnvelope({ data: toMessageData(inFlight) });
        const waitingEnvelope = buildEnvelope({ data: toMessageData(waiting) });
        expect(await breakerGauge()).toBe(0);

        await pause('postgres');
        paused = true;
        await publishEnvelope(app.sqs, queueUrl, inFlightEnvelope);
        await waitFor(async () => (await breakerGauge()) === 1, WAIT);
        await publishEnvelope(app.sqs, queueUrl, waitingEnvelope);
        await waitFor(async () => {
          const counts = await countMessages(app.sqs, queueUrl);
          return counts.visible === 2 && counts.inFlight === 0;
        }, WAIT);

        const steadyUntil = performance.now() + STEADY_WINDOW_MS;
        await waitFor(async () => {
          const counts = await countMessages(app.sqs, queueUrl);
          if (counts.visible !== 2 || counts.inFlight !== 0) {
            throw new QueueNotSteadyError(JSON.stringify(counts));
          }
          if ((await breakerGauge()) !== 1) {
            throw new QueueNotSteadyError('breaker closed');
          }
          return performance.now() >= steadyUntil;
        }, STEADY_POLL);

        const peeked = await peekMessages(app.sqs, queueUrl);
        const receiveCounts = Object.fromEntries(
          peeked.map((message) => [message.body, message.receiveCount]),
        );
        expect(receiveCounts).toEqual({
          [JSON.stringify(inFlightEnvelope)]: 2,
          [JSON.stringify(waitingEnvelope)]: 1,
        });

        await unpause('postgres');
        paused = false;
        await waitFor(async () => (await breakerGauge()) === 0, WAIT);
        await waitFor(
          async () =>
            (await processedCount(database.superuserUrl, [
              inFlight.body.externalTransactionId,
              waiting.body.externalTransactionId,
            ])) === 2,
          WAIT,
        );
        await waitFor(async () => (await countMessages(app.sqs, queueUrl)).total === 0, WAIT);
        expect((await countMessages(app.sqs, app.queueUrls.wagerTransactionsDlq)).total).toBe(0);
      } finally {
        if (paused) {
          await unpause('postgres');
        }
        await app.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
