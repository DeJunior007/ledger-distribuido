import type { OutboxGauges } from './outbox-gauges';

export abstract class MetricsPort {
  abstract transactionRecorded(labels: {
    status: string;
    kind: string;
    channel: string;
    failureCode: string;
  }): void;
  abstract processingDuration(labels: { channel: string; status: string }, seconds: number): void;
  abstract idempotencyReplay(channel: string): void;
  abstract idempotencyConflict(
    channel: string,
    type: 'idempotency_key' | 'external_transaction_id',
  ): void;
  abstract inboxDuplicate(consumer: string): void;
  abstract inboxPayloadMismatch(consumer: string): void;
  abstract sqsRetry(reason: 'transient' | 'connectivity' | 'deterministic'): void;
  abstract sqsDlqMoved(reason: string): void;
  abstract setDlqDepth(queue: string, depth: number): void;
  abstract lockConflict(
    type: 'contended' | 'lock_timeout' | 'version_mismatch' | 'unique_retry',
  ): void;
  abstract walletLockWait(channel: string, seconds: number): void;
  abstract setOutboxGauges(gauges: OutboxGauges): void;
  abstract outboxPublished(result: 'published' | 'transient' | 'permanent'): void;
  abstract outboxPublishLatency(seconds: number): void;
  abstract setPendingOpen(count: number): void;
  abstract pendingResolved(outcome: 'PROCESSED' | 'REJECTED' | 'FAILED'): void;
  abstract pendingFailedPathError(): void;
  abstract reconciliationRun(scope: 'wallet' | 'global', consistent: boolean): void;
  abstract reconciliationMismatch(scope: 'wallet' | 'global'): void;
  abstract anomaly(type: 'reversal_after_win'): void;
  abstract setCircuitBreaker(component: string, open: boolean): void;
}
