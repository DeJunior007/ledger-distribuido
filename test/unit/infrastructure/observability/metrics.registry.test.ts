import { describe, expect, it } from 'bun:test';
import { createMetricsRegistry } from '@infrastructure/observability/metrics.registry';

const EXPECTED_METRICS: readonly (readonly [string, 'counter' | 'gauge' | 'histogram'])[] = [
  ['wager_transactions_total', 'counter'],
  ['idempotency_replays_total', 'counter'],
  ['idempotency_conflicts_total', 'counter'],
  ['inbox_duplicates_total', 'counter'],
  ['inbox_payload_mismatch_total', 'counter'],
  ['sqs_retries_total', 'counter'],
  ['sqs_dlq_moved_total', 'counter'],
  ['sqs_dlq_messages', 'gauge'],
  ['lock_conflicts_total', 'counter'],
  ['wallet_lock_wait_seconds', 'histogram'],
  ['wager_processing_duration_seconds', 'histogram'],
  ['outbox_pending', 'gauge'],
  ['outbox_parked_events', 'gauge'],
  ['outbox_stuck_events', 'gauge'],
  ['outbox_lag_seconds', 'gauge'],
  ['outbox_publish_total', 'counter'],
  ['outbox_publish_latency_seconds', 'histogram'],
  ['pending_reference_open', 'gauge'],
  ['pending_reference_resolved_total', 'counter'],
  ['pending_reference_failed_path_errors_total', 'counter'],
  ['reconciliation_runs_total', 'counter'],
  ['reconciliation_mismatch_total', 'counter'],
  ['wager_anomaly_total', 'counter'],
  ['circuit_breaker_open', 'gauge'],
];

const EXPECTED_LABELS: Readonly<Record<string, readonly string[]>> = {
  wager_transactions_total: ['status', 'kind', 'channel', 'failure_code'],
  idempotency_replays_total: ['channel'],
  idempotency_conflicts_total: ['channel', 'type'],
  inbox_duplicates_total: ['consumer'],
  inbox_payload_mismatch_total: ['consumer'],
  sqs_retries_total: ['reason'],
  sqs_dlq_moved_total: ['reason'],
  sqs_dlq_messages: ['queue'],
  lock_conflicts_total: ['type'],
  wallet_lock_wait_seconds: ['channel'],
  wager_processing_duration_seconds: ['channel', 'status'],
  outbox_publish_total: ['result'],
  pending_reference_resolved_total: ['outcome'],
  reconciliation_runs_total: ['scope', 'consistent'],
  reconciliation_mismatch_total: ['scope'],
  wager_anomaly_total: ['type'],
  circuit_breaker_open: ['component'],
};

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const countOccurrences = (text: string, fragment: string): number =>
  text.split(fragment).length - 1;

describe('createMetricsRegistry', () => {
  it('exposes HELP and TYPE for every metric of the closed list with the jungle_ prefix', async () => {
    const text = await createMetricsRegistry().registry.metrics();
    for (const [name, type] of EXPECTED_METRICS) {
      expect(text).toContain(`# HELP jungle_${name} `);
      expect(text).toContain(`# TYPE jungle_${name} ${type}\n`);
    }
  });

  it('registers each metric with the labels of the closed list', () => {
    const { registry } = createMetricsRegistry();
    for (const [name] of EXPECTED_METRICS) {
      const metric = registry.getSingleMetric(`jungle_${name}`);
      expect(metric).toBeDefined();
      const labelNames: unknown = Reflect.get(metric ?? {}, 'labelNames');
      expect(labelNames).toEqual(EXPECTED_LABELS[name] ?? []);
    }
  });

  it('uses the duration buckets for every histogram', () => {
    const { registry } = createMetricsRegistry();
    for (const [name, type] of EXPECTED_METRICS) {
      if (type !== 'histogram') {
        continue;
      }
      const metric = registry.getSingleMetric(`jungle_${name}`);
      expect(Reflect.get(metric ?? {}, 'upperBounds')).toEqual(DURATION_BUCKETS);
    }
  });

  it('returns the same registry when created twice', () => {
    const first = createMetricsRegistry();
    expect(() => createMetricsRegistry()).not.toThrow();
    expect(createMetricsRegistry()).toBe(first);
    expect(createMetricsRegistry().registry).toBe(first.registry);
  });

  it('collects the default metrics once with the jungle_ prefix', async () => {
    createMetricsRegistry();
    const text = await createMetricsRegistry().registry.metrics();
    expect(text).toContain('jungle_process_resident_memory_bytes');
    expect(countOccurrences(text, '# TYPE jungle_process_resident_memory_bytes ')).toBe(1);
    expect(countOccurrences(text, '# TYPE jungle_wager_transactions_total ')).toBe(1);
  });
});
