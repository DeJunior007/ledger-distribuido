import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { FailureCode } from '@domain/shared/failure-code';
import { DlqReason } from '@interfaces/sqs/dlq-mover';
import { betCommand, createWalletViaApi, submitViaApi } from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import { countMessages, publishBody } from '@test/support/sqs';
import { createTestApp } from '@test/support/test-app';
import type { TestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID } from '@test/support/test-issuer';
import { waitFor } from '@test/support/wait-for';

const SETUP_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 90_000;
const DLQ_WAIT = { timeoutMs: 60_000, intervalMs: 200 } as const;
const PROVIDER_TOKEN = { role: 'provider', providerId: TEST_PROVIDER_ID } as const;

const REQUIRED_METRICS: readonly (readonly [string, string])[] = [
  ['jungle_wager_transactions_total', 'counter'],
  ['jungle_idempotency_replays_total', 'counter'],
  ['jungle_idempotency_conflicts_total', 'counter'],
  ['jungle_inbox_duplicates_total', 'counter'],
  ['jungle_inbox_payload_mismatch_total', 'counter'],
  ['jungle_sqs_retries_total', 'counter'],
  ['jungle_sqs_dlq_moved_total', 'counter'],
  ['jungle_sqs_dlq_messages', 'gauge'],
  ['jungle_lock_conflicts_total', 'counter'],
  ['jungle_wallet_lock_wait_seconds', 'histogram'],
  ['jungle_wager_processing_duration_seconds', 'histogram'],
  ['jungle_outbox_pending', 'gauge'],
  ['jungle_outbox_parked_events', 'gauge'],
  ['jungle_outbox_stuck_events', 'gauge'],
  ['jungle_outbox_lag_seconds', 'gauge'],
  ['jungle_outbox_publish_total', 'counter'],
  ['jungle_outbox_publish_latency_seconds', 'histogram'],
  ['jungle_pending_reference_open', 'gauge'],
  ['jungle_pending_reference_resolved_total', 'counter'],
  ['jungle_pending_reference_failed_path_errors_total', 'counter'],
  ['jungle_reconciliation_runs_total', 'counter'],
  ['jungle_reconciliation_mismatch_total', 'counter'],
  ['jungle_wager_anomaly_total', 'counter'],
  ['jungle_circuit_breaker_open', 'gauge'],
];

type Labels = Readonly<Record<string, string>>;

interface Sample {
  readonly name: string;
  readonly labels: Labels;
  readonly value: number;
}

const SAMPLE_PATTERN = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)$/;
const LABEL_PATTERN = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

const parseLabels = (raw: string | undefined): Labels =>
  Object.fromEntries(
    [...(raw ?? '').matchAll(LABEL_PATTERN)].map((match) => [match[1] ?? '', match[2] ?? '']),
  );

const parseSamples = (text: string): Sample[] =>
  text.split('\n').flatMap((line) => {
    const match = SAMPLE_PATTERN.exec(line);
    if (match === null || line.startsWith('#')) {
      return [];
    }
    return [{ name: match[1] ?? '', labels: parseLabels(match[2]), value: Number(match[3]) }];
  });

const sameLabels = (actual: Labels, expected: Labels): boolean =>
  Object.keys(actual).length === Object.keys(expected).length &&
  Object.entries(expected).every(([key, value]) => actual[key] === value);

const valueOf = (samples: readonly Sample[], name: string, labels: Labels): number =>
  samples.find((sample) => sample.name === name && sameLabels(sample.labels, labels))?.value ?? 0;

let app: TestApp | undefined;

const testApp = (): TestApp => {
  if (app === undefined) {
    throw new TypeError('the metrics test app was not started');
  }
  return app;
};

const scrape = async (): Promise<string> => {
  const response = await fetch(`${testApp().baseUrl}/metrics`);
  expect(response.status).toBe(200);
  return response.text();
};

beforeAll(async () => {
  const database = await createTestDatabase();
  app = await createTestApp({
    roles: ['api', 'consumer'],
    env: { DATABASE_URL: database.appUrl },
  });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await app?.stop();
});

describe('/metrics', () => {
  it('exposes HELP and TYPE for every required metric', async () => {
    const text = await scrape();

    for (const [name, type] of REQUIRED_METRICS) {
      expect(text).toMatch(new RegExp(`^# HELP ${name} \\S`, 'm'));
      expect(text).toContain(`# TYPE ${name} ${type}\n`);
    }
  });

  it(
    'raises the counters of success, replay, conflict, rejection and DLQ with the right labels',
    async () => {
      const operatorToken = await testApp().issuer.token({ role: 'operator' });
      const providerToken = await testApp().issuer.token(PROVIDER_TOKEN);
      const wallet: TestWallet = await createWalletViaApi(testApp().baseUrl, operatorToken, {
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      const before = parseSamples(await scrape());

      const bet = betCommand({ wallet, amount: '10.00' });
      expect((await submitViaApi(testApp().baseUrl, providerToken, bet)).status).toBe(200);
      expect((await submitViaApi(testApp().baseUrl, providerToken, bet)).status).toBe(200);
      const conflicting = {
        ...bet,
        body: { ...bet.body, money: { ...bet.body.money, amount: '11.00' } },
      };
      expect((await submitViaApi(testApp().baseUrl, providerToken, conflicting)).status).toBe(409);
      const rejected = betCommand({ wallet, amount: '500.00' });
      expect((await submitViaApi(testApp().baseUrl, providerToken, rejected)).status).toBe(422);
      await publishBody(testApp().sqs, testApp().queueUrls.wagerTransactions, 'not-json', {
        groupId: wallet.id,
        deduplicationId: crypto.randomUUID(),
      });
      await waitFor(
        async () =>
          (await countMessages(testApp().sqs, testApp().queueUrls.wagerTransactionsDlq)).total >= 1,
        DLQ_WAIT,
      );

      const after = parseSamples(await scrape());
      const delta = (name: string, labels: Labels): number =>
        valueOf(after, name, labels) - valueOf(before, name, labels);

      expect(
        delta('jungle_wager_transactions_total', {
          status: 'PROCESSED',
          kind: 'BET',
          channel: 'http',
          failure_code: 'none',
        }),
      ).toBe(1);
      expect(
        delta('jungle_wager_transactions_total', {
          status: 'REJECTED',
          kind: 'BET',
          channel: 'http',
          failure_code: FailureCode.InsufficientFunds,
        }),
      ).toBe(1);
      expect(delta('jungle_idempotency_replays_total', { channel: 'http' })).toBe(1);
      expect(
        delta('jungle_idempotency_conflicts_total', { channel: 'http', type: 'idempotency_key' }),
      ).toBe(1);
      expect(delta('jungle_sqs_dlq_moved_total', { reason: DlqReason.InvalidPayload })).toBe(1);
      expect(
        delta('jungle_wager_processing_duration_seconds_count', {
          channel: 'http',
          status: 'PROCESSED',
        }),
      ).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});
