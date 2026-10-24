import { MetricsPort } from '@application/ports/metrics.port';
import type { OutboxGauges } from '@application/ports/outbox-gauges';
import type { JungleMetrics } from './metrics.registry';

export class PromMetricsAdapter extends MetricsPort {
  constructor(private readonly metrics: JungleMetrics) {
    super();
  }

  transactionRecorded(labels: {
    status: string;
    kind: string;
    channel: string;
    failureCode: string;
  }): void {
    this.metrics.wagerTransactions.inc({
      status: labels.status,
      kind: labels.kind,
      channel: labels.channel,
      failure_code: labels.failureCode,
    });
  }

  processingDuration(labels: { channel: string; status: string }, seconds: number): void {
    this.metrics.wagerProcessingDuration.observe(
      { channel: labels.channel, status: labels.status },
      seconds,
    );
  }

  idempotencyReplay(channel: string): void {
    this.metrics.idempotencyReplays.inc({ channel });
  }

  idempotencyConflict(channel: string, type: 'idempotency_key' | 'external_transaction_id'): void {
    this.metrics.idempotencyConflicts.inc({ channel, type });
  }

  inboxDuplicate(consumer: string): void {
    this.metrics.inboxDuplicates.inc({ consumer });
  }

  inboxPayloadMismatch(consumer: string): void {
    this.metrics.inboxPayloadMismatch.inc({ consumer });
  }

  sqsRetry(reason: 'transient' | 'connectivity' | 'deterministic'): void {
    this.metrics.sqsRetries.inc({ reason });
  }

  sqsDlqMoved(reason: string): void {
    this.metrics.sqsDlqMoved.inc({ reason });
  }

  setDlqDepth(queue: string, depth: number): void {
    this.metrics.sqsDlqMessages.set({ queue }, depth);
  }

  lockConflict(type: 'contended' | 'lock_timeout' | 'version_mismatch' | 'unique_retry'): void {
    this.metrics.lockConflicts.inc({ type });
  }

  walletLockWait(channel: string, seconds: number): void {
    this.metrics.walletLockWait.observe({ channel }, seconds);
  }

  setOutboxGauges(gauges: OutboxGauges): void {
    this.metrics.outboxPending.set(gauges.pending);
    this.metrics.outboxParked.set(gauges.parked);
    this.metrics.outboxStuck.set(gauges.stuck);
    this.metrics.outboxLag.set(gauges.lagSeconds);
  }

  outboxPublished(result: 'published' | 'transient' | 'permanent'): void {
    this.metrics.outboxPublish.inc({ result });
  }

  outboxPublishLatency(seconds: number): void {
    this.metrics.outboxPublishLatency.observe(seconds);
  }

  setPendingOpen(count: number): void {
    this.metrics.pendingReferenceOpen.set(count);
  }

  pendingResolved(outcome: 'PROCESSED' | 'REJECTED' | 'FAILED'): void {
    this.metrics.pendingReferenceResolved.inc({ outcome });
  }

  pendingFailedPathError(): void {
    this.metrics.pendingReferenceFailedPathErrors.inc();
  }

  reconciliationRun(scope: 'wallet' | 'global', consistent: boolean): void {
    this.metrics.reconciliationRuns.inc({ scope, consistent: consistent ? 'true' : 'false' });
  }

  reconciliationMismatch(scope: 'wallet' | 'global'): void {
    this.metrics.reconciliationMismatch.inc({ scope });
  }

  anomaly(type: 'reversal_after_win'): void {
    this.metrics.wagerAnomaly.inc({ type });
  }

  setCircuitBreaker(component: string, open: boolean): void {
    this.metrics.circuitBreakerOpen.set({ component }, open ? 1 : 0);
  }
}
