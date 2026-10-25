import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Client } from 'pg';
import { z } from 'zod';
import { createSqsClient } from '@infrastructure/messaging/sqs.client';
import { buildEnvelope, publishEnvelope } from '@test/support/sqs';
import { waitFor } from '@test/support/wait-for';

type KeycloakClient = 'provider-a' | 'backoffice';

const TOKEN_URL = 'http://localhost:8081/realms/jungle/protocol/openid-connect/token';
const API_URL = 'http://localhost:8080';
const PROMETHEUS_URL = 'http://localhost:9090';
const GRAFANA_URL = 'http://localhost:3001';
const JAEGER_URL = 'http://localhost:16686';
const SQS_ENDPOINT = 'http://localhost:4566';
const DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/jungle';
const DASHBOARD_PATH = 'infra/grafana/provisioning/dashboards/jungle-overview.json';
const DASHBOARD_UID = 'jungle-overview';
const GRAFANA_CREDENTIALS = `Basic ${Buffer.from('admin:admin').toString('base64')}`;
const WAGER_QUEUE_NAME = 'wager-transactions.fifo';
const WAGER_CONSUMER = 'wager-transactions-consumer';
const AUDIT_CONSUMER = 'wallet-events-audit';
const PROVIDER_ID = 'provider-a';
const CURRENCY = 'BRL';
const SQS_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 2_000;
const SCRAPE_JOB = 'jungle';
const PROCESSED_BETS_QUERY =
  'sum(jungle_wager_transactions_total{status="PROCESSED",channel="http",kind="BET"})';
const SERVICE_REPLICAS: Readonly<Record<string, number>> = {
  api: 3,
  consumer: 3,
  outbox: 2,
  scheduler: 2,
  'events-audit': 1,
};
const TARGET_COUNT = Object.values(SERVICE_REPLICAS).reduce((total, count) => total + count, 0);
const TARGETS_WAIT = { timeoutMs: 120_000, intervalMs: 1_000 } as const;
const METRIC_WAIT = { timeoutMs: 60_000, intervalMs: 1_000 } as const;
const TRACE_WAIT = { timeoutMs: 60_000, intervalMs: 1_000 } as const;
const QUEUE_WAIT = { timeoutMs: 60_000, intervalMs: 250 } as const;
const SLOW_TEST_MS = 180_000;

const tokenResponseSchema = z.object({ access_token: z.string().min(1) });
const createdWalletSchema = z.object({ id: z.string(), playerId: z.string() });
const transactionResultSchema = z.object({ status: z.string() }).passthrough();
const targetsSchema = z.object({
  status: z.literal('success'),
  data: z.object({
    activeTargets: z.array(
      z.object({
        discoveredLabels: z.record(z.string()),
        labels: z.record(z.string()),
        health: z.string(),
      }),
    ),
  }),
});
const querySchema = z.object({
  status: z.string(),
  data: z.object({
    result: z.array(
      z.object({ metric: z.record(z.string()), value: z.tuple([z.number(), z.string()]) }),
    ),
  }),
});
const grafanaHealthSchema = z.object({ database: z.string() }).passthrough();
const grafanaSearchSchema = z.array(z.object({ uid: z.string(), type: z.string() }).passthrough());
const dashboardSchema = z.object({
  uid: z.string(),
  panels: z.array(
    z.object({ title: z.string(), targets: z.array(z.object({ expr: z.string() }).passthrough()) }),
  ),
});
const servicesSchema = z.object({ data: z.array(z.string()).nullable() });
const spanSchema = z.object({
  traceID: z.string(),
  spanID: z.string(),
  operationName: z.string(),
  processID: z.string(),
  references: z.array(z.object({ refType: z.string(), traceID: z.string(), spanID: z.string() })),
});
const traceSchema = z.object({
  traceID: z.string(),
  spans: z.array(spanSchema),
  processes: z.record(z.object({ serviceName: z.string() })),
});
const tracesSchema = z.object({ data: z.array(traceSchema).nullable() });
const countRowSchema = z.object({ count: z.number() });

type Trace = z.infer<typeof traceSchema>;

interface NamedSpan {
  readonly spanID: string;
  readonly operationName: string;
  readonly service: string;
  readonly parentSpanIds: readonly string[];
}

const respondsWithin = async (url: string): Promise<boolean> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
};

const prometheusAvailable = await respondsWithin(`${PROMETHEUS_URL}/-/ready`);
const SKIP_REASON =
  'skipped: Prometheus did not answer at localhost:9090; start the stack with OTEL_ENABLED=true docker compose --profile observability up -d --build --wait';

if (!prometheusAvailable) {
  process.stderr.write(`observability e2e ${SKIP_REASON}\n`);
}

const clientToken = async (client: KeycloakClient): Promise<string> => {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: client,
      client_secret: `${client}-secret`,
    }),
  });
  expect(response.status).toBe(200);
  return tokenResponseSchema.parse(await response.json()).access_token;
};

const headersFor = (token: string, extra: Record<string, string> = {}): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  ...extra,
});

const createWallet = async (
  operatorToken: string,
  extraHeaders: Record<string, string> = {},
): Promise<z.infer<typeof createdWalletSchema>> => {
  const response = await fetch(`${API_URL}/wallets`, {
    method: 'POST',
    headers: headersFor(operatorToken, extraHeaders),
    body: JSON.stringify({
      playerId: randomUUID(),
      initialBalance: { amount: '100.00', currency: CURRENCY },
    }),
  });
  expect(response.status).toBe(201);
  return createdWalletSchema.parse(await response.json());
};

const submitBet = async (
  providerToken: string,
  wallet: z.infer<typeof createdWalletSchema>,
): Promise<string> => {
  const id = randomUUID();
  const response = await fetch(`${API_URL}/wagering/transactions`, {
    method: 'POST',
    headers: headersFor(providerToken, { 'Idempotency-Key': `idem-${id}` }),
    body: JSON.stringify({
      providerId: PROVIDER_ID,
      externalTransactionId: `ext-${id}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${id}`,
      gameId: 'observability-game',
      kind: 'BET',
      money: { amount: '10.00', currency: CURRENCY },
    }),
  });
  expect(response.status).toBe(200);
  return transactionResultSchema.parse(await response.json()).status;
};

const prometheusQuery = async (expr: string): Promise<z.infer<typeof querySchema>> => {
  const response = await fetch(
    `${PROMETHEUS_URL}/api/v1/query?${new URLSearchParams({ query: expr }).toString()}`,
  );
  expect({ expr, status: response.status }).toEqual({ expr, status: 200 });
  return querySchema.parse(await response.json());
};

const scalarOf = (result: z.infer<typeof querySchema>): number =>
  Number(result.data.result[0]?.value[1] ?? '0');

const jungleTargets = async (): Promise<z.infer<typeof targetsSchema>['data']['activeTargets']> => {
  const response = await fetch(`${PROMETHEUS_URL}/api/v1/targets?state=active`);
  expect(response.status).toBe(200);
  return targetsSchema
    .parse(await response.json())
    .data.activeTargets.filter((target) => target.labels.job === SCRAPE_JOB);
};

const jaegerServices = async (): Promise<string[]> => {
  const response = await fetch(`${JAEGER_URL}/api/services`);
  expect(response.status).toBe(200);
  return servicesSchema.parse(await response.json()).data ?? [];
};

const jaegerTrace = async (traceId: string): Promise<Trace | undefined> => {
  const response = await fetch(`${JAEGER_URL}/api/traces/${traceId}`);
  if (response.status === 404) {
    await response.body?.cancel();
    return undefined;
  }
  expect(response.status).toBe(200);
  return tracesSchema.parse(await response.json()).data?.[0];
};

const searchTraces = async (
  service: string,
  operation: string,
  startMicros: number,
): Promise<Trace[]> => {
  const query = new URLSearchParams({
    service,
    operation,
    start: String(startMicros),
    end: String(Date.now() * 1000),
    limit: '200',
  });
  const response = await fetch(`${JAEGER_URL}/api/traces?${query.toString()}`);
  expect(response.status).toBe(200);
  return tracesSchema.parse(await response.json()).data ?? [];
};

const namedSpans = (trace: Trace): NamedSpan[] =>
  trace.spans.map((span) => ({
    spanID: span.spanID,
    operationName: span.operationName,
    service: trace.processes[span.processID]?.serviceName ?? '',
    parentSpanIds: span.references
      .filter((reference) => reference.refType === 'CHILD_OF')
      .map((reference) => reference.spanID),
  }));

const continuesOutboxPublish = (trace: Trace): boolean => {
  const spans = namedSpans(trace);
  const publishSpans = new Set(
    spans
      .filter((span) => span.service === 'outbox' && span.operationName === 'outbox.publish')
      .map((span) => span.spanID),
  );
  return spans.some(
    (span) =>
      span.service === 'events-audit' &&
      span.operationName === 'sqs.process' &&
      span.parentSpanIds.some((parent) => publishSpans.has(parent)),
  );
};

const missingFrom = (actual: readonly string[], expected: readonly string[]): string[] =>
  expected.filter((name) => !actual.includes(name));

const hexId = (bytes: number): string => randomBytes(bytes).toString('hex');

const countRows = async (database: Client, sql: string, values: unknown[]): Promise<number> => {
  const result = await database.query(sql, values);
  return countRowSchema.parse(result.rows[0]).count;
};

describe.skipIf(!prometheusAvailable)(
  prometheusAvailable ? 'observability stack' : `observability stack (${SKIP_REASON})`,
  () => {
    const database = new Client({ connectionString: DATABASE_URL });
    const sqs: SQSClient = createSqsClient(
      {
        SQS_ENDPOINT,
        AWS_REGION: 'us-east-1',
        AWS_ACCESS_KEY_ID: 'test',
        AWS_SECRET_ACCESS_KEY: 'test',
        SQS_REQUEST_TIMEOUT_MS: SQS_TIMEOUT_MS,
        SQS_RECEIVE_WAIT_SECONDS: 1,
      },
      SQS_TIMEOUT_MS,
    );
    let operatorToken = '';
    let providerToken = '';

    beforeAll(async () => {
      await database.connect();
      [operatorToken, providerToken] = await Promise.all([
        clientToken('backoffice'),
        clientToken('provider-a'),
      ]);
    });

    afterAll(async () => {
      sqs.destroy();
      await database.end();
    });

    it(
      'scrapes every replica of the jungle job as up',
      async () => {
        let targets: Awaited<ReturnType<typeof jungleTargets>> = [];
        await waitFor(async () => {
          targets = await jungleTargets();
          return (
            targets.length === TARGET_COUNT && targets.every((target) => target.health === 'up')
          );
        }, TARGETS_WAIT);

        const perService: Record<string, number> = {};
        for (const target of targets) {
          const service = target.discoveredLabels.__meta_dns_name ?? '';
          perService[service] = (perService[service] ?? 0) + 1;
        }
        expect(perService).toEqual(SERVICE_REPLICAS);
      },
      { timeout: SLOW_TEST_MS },
    );

    it(
      'exposes a PROCESSED series of jungle_wager_transactions_total after a bet',
      async () => {
        const before = scalarOf(await prometheusQuery(PROCESSED_BETS_QUERY));
        const wallet = await createWallet(operatorToken);
        expect(await submitBet(providerToken, wallet)).toBe('PROCESSED');

        await waitFor(
          async () => scalarOf(await prometheusQuery(PROCESSED_BETS_QUERY)) > before,
          METRIC_WAIT,
        );
        const series = await prometheusQuery('jungle_wager_transactions_total{status="PROCESSED"}');
        expect(series.status).toBe('success');
        expect(series.data.result.length).toBeGreaterThan(0);
        expect(series.data.result.every((entry) => entry.metric.status === 'PROCESSED')).toBe(true);
      },
      { timeout: SLOW_TEST_MS },
    );

    it('serves a healthy grafana with the provisioned dashboard', async () => {
      const health = await fetch(`${GRAFANA_URL}/api/health`);
      expect(health.status).toBe(200);
      expect(grafanaHealthSchema.parse(await health.json()).database).toBe('ok');

      const search = await fetch(
        `${GRAFANA_URL}/api/search?${new URLSearchParams({ query: DASHBOARD_UID }).toString()}`,
        { headers: { Authorization: GRAFANA_CREDENTIALS } },
      );
      expect(search.status).toBe(200);
      const dashboards = grafanaSearchSchema
        .parse(await search.json())
        .map((entry) => ({ uid: entry.uid, type: entry.type }));
      expect(dashboards).toContainEqual({ uid: DASHBOARD_UID, type: 'dash-db' });
    });

    it('evaluates every dashboard expression in prometheus', async () => {
      const dashboard = dashboardSchema.parse(await Bun.file(DASHBOARD_PATH).json());
      expect(dashboard.uid).toBe(DASHBOARD_UID);
      const expressions = dashboard.panels.flatMap((panel) =>
        panel.targets.map((target) => ({ panel: panel.title, expr: target.expr })),
      );
      expect(expressions.length).toBeGreaterThan(0);

      const results = await Promise.all(
        expressions.map(async (entry) => ({
          ...entry,
          status: (await prometheusQuery(entry.expr)).status,
        })),
      );
      expect(results.filter((entry) => entry.status !== 'success')).toEqual([]);
    });

    it(
      'lists api, outbox, events-audit and consumer as jaeger services',
      async () => {
        let services: string[] = [];
        await waitFor(async () => {
          services = await jaegerServices();
          return ['api', 'outbox', 'events-audit'].every((name) => services.includes(name));
        }, TRACE_WAIT);
        expect(missingFrom(services, ['api', 'outbox', 'events-audit'])).toEqual([]);

        const wallet = await createWallet(operatorToken);
        const queue = await sqs.send(new GetQueueUrlCommand({ QueueName: WAGER_QUEUE_NAME }));
        const queueUrl = queue.QueueUrl ?? '';
        expect(queueUrl).not.toBe('');
        const traceId = hexId(16);
        const envelope = buildEnvelope({
          data: {
            providerId: PROVIDER_ID,
            walletId: wallet.id,
            playerId: wallet.playerId,
            money: { amount: '5.00', currency: CURRENCY },
          },
        });
        await publishEnvelope(sqs, queueUrl, envelope, {
          traceparent: `00-${traceId}-${hexId(8)}-01`,
        });
        await waitFor(
          async () =>
            (await countRows(
              database,
              `SELECT count(*)::int AS count FROM inbox_messages
               WHERE consumer_name = $1 AND message_id = $2 AND processed_at IS NOT NULL`,
              [WAGER_CONSUMER, envelope.messageId],
            )) === 1,
          QUEUE_WAIT,
        );

        let consumerSpans: NamedSpan[] = [];
        await waitFor(async () => {
          const trace = await jaegerTrace(traceId);
          consumerSpans =
            trace === undefined
              ? []
              : namedSpans(trace).filter((span) => span.service === 'consumer');
          return consumerSpans.some((span) => span.operationName === 'sqs.process');
        }, TRACE_WAIT);
        expect(
          missingFrom(
            consumerSpans.map((span) => span.operationName),
            ['sqs.process', 'usecase.submit_wager_transaction'],
          ),
        ).toEqual([]);
        expect(await jaegerServices()).toContain('consumer');
      },
      { timeout: SLOW_TEST_MS },
    );

    it(
      'traces a POST /wallets from a known traceparent and continues the event trace in the events-audit',
      async () => {
        const startMicros = Date.now() * 1000;
        const traceId = hexId(16);
        const parentSpanId = hexId(8);
        const wallet = await createWallet(operatorToken, {
          traceparent: `00-${traceId}-${parentSpanId}-01`,
        });

        let spans: NamedSpan[] = [];
        await waitFor(async () => {
          const trace = await jaegerTrace(traceId);
          spans = trace === undefined ? [] : namedSpans(trace);
          const names = spans.map((span) => span.operationName);
          return (
            names.includes('http.request') &&
            names.some((name) => name.startsWith('usecase.')) &&
            names.includes('db.transaction')
          );
        }, TRACE_WAIT);
        const request = spans.find((span) => span.operationName === 'http.request');
        expect(request).toMatchObject({ service: 'api', parentSpanIds: [parentSpanId] });
        expect(spans.find((span) => span.operationName === 'usecase.create_wallet')).toMatchObject({
          service: 'api',
          parentSpanIds: [request?.spanID ?? ''],
        });
        expect(spans.filter((span) => span.operationName === 'db.transaction')).not.toHaveLength(0);

        await waitFor(
          async () =>
            (await countRows(
              database,
              `SELECT count(*)::int AS count FROM outbox_messages o
               JOIN inbox_messages i ON i.consumer_name = $2 AND i.message_id = o.id::text
               WHERE o.aggregate_id = $1 AND i.processed_at IS NOT NULL`,
              [wallet.id, AUDIT_CONSUMER],
            )) > 0,
          QUEUE_WAIT,
        );
        await waitFor(
          async () =>
            (await searchTraces('events-audit', 'sqs.process', startMicros)).some(
              continuesOutboxPublish,
            ),
          TRACE_WAIT,
        );
      },
      { timeout: SLOW_TEST_MS },
    );
  },
);
