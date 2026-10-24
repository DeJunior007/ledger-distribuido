import { describe, expect, it } from 'bun:test';
import { createMetricsRegistry } from '@infrastructure/observability/metrics.registry';
import { PromMetricsAdapter } from '@infrastructure/observability/prom-metrics.adapter';
import { sampleValue } from './metric-values';

const { registry, metrics } = createMetricsRegistry();
const adapter = new PromMetricsAdapter(metrics);

const delta = async (
  name: string,
  labels: Readonly<Record<string, string>>,
  action: () => void,
  sampleName?: string,
): Promise<number> => {
  const before = await sampleValue(registry, name, labels, sampleName);
  action();
  const after = await sampleValue(registry, name, labels, sampleName);
  return after - before;
};

const value = (name: string, labels: Readonly<Record<string, string>> = {}): Promise<number> =>
  sampleValue(registry, name, labels);

describe('PromMetricsAdapter', () => {
  it('transactionRecorded increments wager_transactions_total with the four labels', async () => {
    const labels = {
      status: 'REJECTED',
      kind: 'BET',
      channel: 'http',
      failure_code: 'INSUFFICIENT_FUNDS',
    };
    const increase = await delta('jungle_wager_transactions_total', labels, () => {
      adapter.transactionRecorded({
        status: 'REJECTED',
        kind: 'BET',
        channel: 'http',
        failureCode: 'INSUFFICIENT_FUNDS',
      });
    });
    expect(increase).toBe(1);
  });

  it('processingDuration observes wager_processing_duration_seconds', async () => {
    const name = 'jungle_wager_processing_duration_seconds';
    const labels = { channel: 'sqs', status: 'PROCESSED' };
    const count = await delta(
      name,
      labels,
      () => {
        adapter.processingDuration({ channel: 'sqs', status: 'PROCESSED' }, 0.2);
      },
      `${name}_count`,
    );
    expect(count).toBe(1);
    expect(await sampleValue(registry, name, labels, `${name}_sum`)).toBeGreaterThanOrEqual(0.2);
  });

  it('idempotencyReplay increments idempotency_replays_total', async () => {
    const increase = await delta('jungle_idempotency_replays_total', { channel: 'http' }, () => {
      adapter.idempotencyReplay('http');
    });
    expect(increase).toBe(1);
  });

  it('idempotencyConflict increments idempotency_conflicts_total with the type', async () => {
    const labels = { channel: 'sqs', type: 'external_transaction_id' };
    const increase = await delta('jungle_idempotency_conflicts_total', labels, () => {
      adapter.idempotencyConflict('sqs', 'external_transaction_id');
    });
    expect(increase).toBe(1);
  });

  it('inboxDuplicate increments inbox_duplicates_total', async () => {
    const labels = { consumer: 'wager-transactions-consumer' };
    const increase = await delta('jungle_inbox_duplicates_total', labels, () => {
      adapter.inboxDuplicate('wager-transactions-consumer');
    });
    expect(increase).toBe(1);
  });

  it('inboxPayloadMismatch increments inbox_payload_mismatch_total', async () => {
    const labels = { consumer: 'wallet-events-audit' };
    const increase = await delta('jungle_inbox_payload_mismatch_total', labels, () => {
      adapter.inboxPayloadMismatch('wallet-events-audit');
    });
    expect(increase).toBe(1);
  });

  it('sqsRetry increments sqs_retries_total', async () => {
    const increase = await delta('jungle_sqs_retries_total', { reason: 'connectivity' }, () => {
      adapter.sqsRetry('connectivity');
    });
    expect(increase).toBe(1);
  });

  it('sqsDlqMoved increments sqs_dlq_moved_total', async () => {
    const increase = await delta(
      'jungle_sqs_dlq_moved_total',
      { reason: 'INVALID_PAYLOAD' },
      () => {
        adapter.sqsDlqMoved('INVALID_PAYLOAD');
      },
    );
    expect(increase).toBe(1);
  });

  it('setDlqDepth sets sqs_dlq_messages for the queue', async () => {
    adapter.setDlqDepth('wager-transactions-dlq.fifo', 7);
    expect(await value('jungle_sqs_dlq_messages', { queue: 'wager-transactions-dlq.fifo' })).toBe(
      7,
    );
  });

  it('lockConflict increments lock_conflicts_total', async () => {
    const increase = await delta('jungle_lock_conflicts_total', { type: 'lock_timeout' }, () => {
      adapter.lockConflict('lock_timeout');
    });
    expect(increase).toBe(1);
  });

  it('walletLockWait observes wallet_lock_wait_seconds', async () => {
    const name = 'jungle_wallet_lock_wait_seconds';
    const count = await delta(
      name,
      { channel: 'scheduler' },
      () => {
        adapter.walletLockWait('scheduler', 0.03);
      },
      `${name}_count`,
    );
    expect(count).toBe(1);
  });

  it('setOutboxGauges sets the four outbox gauges', async () => {
    adapter.setOutboxGauges({ pending: 4, parked: 1, stuck: 2, lagSeconds: 12.5 });
    expect(await value('jungle_outbox_pending')).toBe(4);
    expect(await value('jungle_outbox_parked_events')).toBe(1);
    expect(await value('jungle_outbox_stuck_events')).toBe(2);
    expect(await value('jungle_outbox_lag_seconds')).toBe(12.5);
  });

  it('outboxPublished increments outbox_publish_total', async () => {
    const increase = await delta('jungle_outbox_publish_total', { result: 'transient' }, () => {
      adapter.outboxPublished('transient');
    });
    expect(increase).toBe(1);
  });

  it('outboxPublishLatency observes outbox_publish_latency_seconds', async () => {
    const name = 'jungle_outbox_publish_latency_seconds';
    const count = await delta(
      name,
      {},
      () => {
        adapter.outboxPublishLatency(0.01);
      },
      `${name}_count`,
    );
    expect(count).toBe(1);
  });

  it('setPendingOpen sets pending_reference_open', async () => {
    adapter.setPendingOpen(3);
    expect(await value('jungle_pending_reference_open')).toBe(3);
  });

  it('pendingResolved increments pending_reference_resolved_total', async () => {
    const increase = await delta(
      'jungle_pending_reference_resolved_total',
      { outcome: 'FAILED' },
      () => {
        adapter.pendingResolved('FAILED');
      },
    );
    expect(increase).toBe(1);
  });

  it('pendingFailedPathError increments pending_reference_failed_path_errors_total', async () => {
    const increase = await delta('jungle_pending_reference_failed_path_errors_total', {}, () => {
      adapter.pendingFailedPathError();
    });
    expect(increase).toBe(1);
  });

  it('reconciliationRun increments reconciliation_runs_total with consistent as text', async () => {
    const consistent = await delta(
      'jungle_reconciliation_runs_total',
      { scope: 'global', consistent: 'true' },
      () => {
        adapter.reconciliationRun('global', true);
      },
    );
    const inconsistent = await delta(
      'jungle_reconciliation_runs_total',
      { scope: 'wallet', consistent: 'false' },
      () => {
        adapter.reconciliationRun('wallet', false);
      },
    );
    expect(consistent).toBe(1);
    expect(inconsistent).toBe(1);
  });

  it('reconciliationMismatch increments reconciliation_mismatch_total', async () => {
    const increase = await delta(
      'jungle_reconciliation_mismatch_total',
      { scope: 'wallet' },
      () => {
        adapter.reconciliationMismatch('wallet');
      },
    );
    expect(increase).toBe(1);
  });

  it('anomaly increments wager_anomaly_total', async () => {
    const increase = await delta(
      'jungle_wager_anomaly_total',
      { type: 'reversal_after_win' },
      () => {
        adapter.anomaly('reversal_after_win');
      },
    );
    expect(increase).toBe(1);
  });

  it('setCircuitBreaker sets circuit_breaker_open to 1 when open and 0 when closed', async () => {
    adapter.setCircuitBreaker('outbox', true);
    expect(await value('jungle_circuit_breaker_open', { component: 'outbox' })).toBe(1);
    adapter.setCircuitBreaker('outbox', false);
    expect(await value('jungle_circuit_breaker_open', { component: 'outbox' })).toBe(0);
  });
});
