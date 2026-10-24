import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const METRIC_PREFIX = 'jungle_';

export const DURATION_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

const counter = <L extends string>(
  register: Registry,
  name: string,
  help: string,
  labelNames: readonly L[],
): Counter<L> =>
  new Counter({ name: `${METRIC_PREFIX}${name}`, help, labelNames, registers: [register] });

const gauge = <L extends string>(
  register: Registry,
  name: string,
  help: string,
  labelNames: readonly L[],
): Gauge<L> =>
  new Gauge({ name: `${METRIC_PREFIX}${name}`, help, labelNames, registers: [register] });

const histogram = <L extends string>(
  register: Registry,
  name: string,
  help: string,
  labelNames: readonly L[],
): Histogram<L> =>
  new Histogram({
    name: `${METRIC_PREFIX}${name}`,
    help,
    labelNames,
    buckets: [...DURATION_BUCKETS],
    registers: [register],
  });

const buildMetrics = (register: Registry) => ({
  wagerTransactions: counter(
    register,
    'wager_transactions_total',
    'Wager transactions recorded by final status',
    ['status', 'kind', 'channel', 'failure_code'],
  ),
  idempotencyReplays: counter(
    register,
    'idempotency_replays_total',
    'Requests answered from a stored idempotent result',
    ['channel'],
  ),
  idempotencyConflicts: counter(
    register,
    'idempotency_conflicts_total',
    'Requests rejected because a key was reused with another payload',
    ['channel', 'type'],
  ),
  inboxDuplicates: counter(
    register,
    'inbox_duplicates_total',
    'Messages already present in the inbox',
    ['consumer'],
  ),
  inboxPayloadMismatch: counter(
    register,
    'inbox_payload_mismatch_total',
    'Messages whose payload differs from the inbox record',
    ['consumer'],
  ),
  sqsRetries: counter(register, 'sqs_retries_total', 'Messages left for SQS redelivery', [
    'reason',
  ]),
  sqsDlqMoved: counter(register, 'sqs_dlq_moved_total', 'Messages sent to the DLQ', ['reason']),
  sqsDlqMessages: gauge(register, 'sqs_dlq_messages', 'Approximate messages in the DLQ', ['queue']),
  lockConflicts: counter(register, 'lock_conflicts_total', 'Wallet lock conflicts', ['type']),
  walletLockWait: histogram(
    register,
    'wallet_lock_wait_seconds',
    'Time spent waiting for the wallet lock',
    ['channel'],
  ),
  wagerProcessingDuration: histogram(
    register,
    'wager_processing_duration_seconds',
    'Wager transaction processing duration',
    ['channel', 'status'],
  ),
  outboxPending: gauge(register, 'outbox_pending', 'Outbox events waiting to be published', []),
  outboxParked: gauge(register, 'outbox_parked_events', 'Outbox events parked after failures', []),
  outboxStuck: gauge(register, 'outbox_stuck_events', 'Outbox events with an expired lease', []),
  outboxLag: gauge(register, 'outbox_lag_seconds', 'Age of the oldest pending outbox event', []),
  outboxPublish: counter(register, 'outbox_publish_total', 'Outbox publish attempts by result', [
    'result',
  ]),
  outboxPublishLatency: histogram(
    register,
    'outbox_publish_latency_seconds',
    'Latency of outbox publish calls',
    [],
  ),
  pendingReferenceOpen: gauge(
    register,
    'pending_reference_open',
    'Transactions waiting for their reference',
    [],
  ),
  pendingReferenceResolved: counter(
    register,
    'pending_reference_resolved_total',
    'Pending reference transactions resolved by outcome',
    ['outcome'],
  ),
  pendingReferenceFailedPathErrors: counter(
    register,
    'pending_reference_failed_path_errors_total',
    'Errors while moving a pending reference transaction to failed',
    [],
  ),
  reconciliationRuns: counter(
    register,
    'reconciliation_runs_total',
    'Reconciliation runs by scope and result',
    ['scope', 'consistent'],
  ),
  reconciliationMismatch: counter(
    register,
    'reconciliation_mismatch_total',
    'Reconciliation runs that found a mismatch',
    ['scope'],
  ),
  wagerAnomaly: counter(register, 'wager_anomaly_total', 'Wager anomalies detected', ['type']),
  circuitBreakerOpen: gauge(
    register,
    'circuit_breaker_open',
    'Whether the circuit breaker of a component is open',
    ['component'],
  ),
});

export type JungleMetrics = ReturnType<typeof buildMetrics>;

export interface MetricsRegistry {
  readonly registry: Registry;
  readonly metrics: JungleMetrics;
}

let instance: MetricsRegistry | undefined;

export const createMetricsRegistry = (): MetricsRegistry => {
  if (instance !== undefined) {
    return instance;
  }
  const registry = new Registry();
  const metrics = buildMetrics(registry);
  collectDefaultMetrics({ register: registry, prefix: METRIC_PREFIX });
  instance = { registry, metrics };
  return instance;
};
