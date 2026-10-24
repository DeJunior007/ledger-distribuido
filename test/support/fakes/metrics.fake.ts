import type { OutboxGauges } from '@application/ports/outbox-gauges';
import { MetricsPort } from '@application/ports/metrics.port';

type Labels = Readonly<Record<string, string>>;

const seriesKey = (name: string, labels: Labels): string => {
  const rendered = Object.keys(labels)
    .sort()
    .map((label) => `${label}="${labels[label] ?? ''}"`)
    .join(',');
  return `${name}{${rendered}}`;
};

export class FakeMetrics extends MetricsPort {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, number[]>();

  counter(name: string, labels: Labels = {}): number {
    return this.counters.get(seriesKey(name, labels)) ?? 0;
  }

  gauge(name: string, labels: Labels = {}): number | undefined {
    return this.gauges.get(seriesKey(name, labels));
  }

  observations(name: string, labels: Labels = {}): readonly number[] {
    return [...(this.histograms.get(seriesKey(name, labels)) ?? [])];
  }

  transactionRecorded(labels: {
    status: string;
    kind: string;
    channel: string;
    failureCode: string;
  }): void {
    this.increment('wager_transactions_total', {
      status: labels.status,
      kind: labels.kind,
      channel: labels.channel,
      failure_code: labels.failureCode,
    });
  }

  processingDuration(labels: { channel: string; status: string }, seconds: number): void {
    this.observe('wager_processing_duration_seconds', labels, seconds);
  }

  idempotencyReplay(channel: string): void {
    this.increment('idempotency_replays_total', { channel });
  }

  idempotencyConflict(channel: string, type: 'idempotency_key' | 'external_transaction_id'): void {
    this.increment('idempotency_conflicts_total', { channel, type });
  }

  inboxDuplicate(consumer: string): void {
    this.increment('inbox_duplicates_total', { consumer });
  }

  inboxPayloadMismatch(consumer: string): void {
    this.increment('inbox_payload_mismatch_total', { consumer });
  }

  sqsRetry(reason: 'transient' | 'connectivity' | 'deterministic'): void {
    this.increment('sqs_retries_total', { reason });
  }

  sqsDlqMoved(reason: string): void {
    this.increment('sqs_dlq_moved_total', { reason });
  }

  setDlqDepth(queue: string, depth: number): void {
    this.set('sqs_dlq_messages', { queue }, depth);
  }

  lockConflict(type: 'contended' | 'lock_timeout' | 'version_mismatch' | 'unique_retry'): void {
    this.increment('lock_conflicts_total', { type });
  }

  walletLockWait(channel: string, seconds: number): void {
    this.observe('wallet_lock_wait_seconds', { channel }, seconds);
  }

  setOutboxGauges(gauges: OutboxGauges): void {
    this.set('outbox_pending', {}, gauges.pending);
    this.set('outbox_parked_events', {}, gauges.parked);
    this.set('outbox_stuck_events', {}, gauges.stuck);
    this.set('outbox_lag_seconds', {}, gauges.lagSeconds);
  }

  outboxPublished(result: 'published' | 'transient' | 'permanent'): void {
    this.increment('outbox_publish_total', { result });
  }

  outboxPublishLatency(seconds: number): void {
    this.observe('outbox_publish_latency_seconds', {}, seconds);
  }

  setPendingOpen(count: number): void {
    this.set('pending_reference_open', {}, count);
  }

  pendingResolved(outcome: 'PROCESSED' | 'REJECTED' | 'FAILED'): void {
    this.increment('pending_reference_resolved_total', { outcome });
  }

  pendingFailedPathError(): void {
    this.increment('pending_reference_failed_path_errors_total', {});
  }

  reconciliationRun(scope: 'wallet' | 'global', consistent: boolean): void {
    this.increment('reconciliation_runs_total', { scope, consistent: String(consistent) });
  }

  reconciliationMismatch(scope: 'wallet' | 'global'): void {
    this.increment('reconciliation_mismatch_total', { scope });
  }

  anomaly(type: 'reversal_after_win'): void {
    this.increment('wager_anomaly_total', { type });
  }

  setCircuitBreaker(component: string, open: boolean): void {
    this.set('circuit_breaker_open', { component }, open ? 1 : 0);
  }

  private increment(name: string, labels: Labels): void {
    const key = seriesKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  private set(name: string, labels: Labels, value: number): void {
    this.gauges.set(seriesKey(name, labels), value);
  }

  private observe(name: string, labels: Labels, value: number): void {
    const key = seriesKey(name, labels);
    this.histograms.set(key, [...(this.histograms.get(key) ?? []), value]);
  }
}
