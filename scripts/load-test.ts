import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { chunk } from '@application/services/chunk';
import type { MoneyProps } from '@domain/shared/money';

export const K6_IMAGE = 'grafana/k6:1.8.1';
export const SCENARIOS = ['hot-wallet', 'distributed'] as const;
export const DEFAULT_DURATION = '60s';
export const RESULTS_DIR = 'load-test-results';
export const CURRENCY = 'BRL';
export const DISTRIBUTED_WALLETS = 1000;

export type Scenario = (typeof SCENARIOS)[number];

const SCENARIO_PLANS: Readonly<
  Record<Scenario, { readonly wallets: number; readonly initialBalance: string }>
> = {
  'hot-wallet': { wallets: 1, initialBalance: '1000000.00' },
  distributed: { wallets: DISTRIBUTED_WALLETS, initialBalance: '100000.00' },
};

const HTTP_CONCURRENCY = 10;
const UNAVAILABLE_RETRIES = 10;
const UNAVAILABLE_BACKOFF_MS = 1_000;
const SERVICE_UNAVAILABLE = 503;
const HTTP_TIMEOUT_MS = 30_000;
const TOKEN_REFRESH_MARGIN_MS = 30_000;
const PROMETHEUS_SETTLE_MS = 12_000;
const SUMMARY_START = '<<<k6-summary>>>';
const SUMMARY_END = '<<<end-k6-summary>>>';
const DURATION_PATTERN = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
const EXPECTED_STATUSES = new Set(['200', '202', '422']);
const STATUS_METRIC_PREFIX = 'wager_status_';

export interface LoadTestOptions {
  readonly duration: string;
  readonly scenarios: readonly Scenario[];
  readonly apiUrl: string;
  readonly tokenUrl: string;
  readonly prometheusUrl: string;
  readonly k6ApiUrl: string;
  readonly k6TokenUrl: string;
  readonly operatorClientId: string;
  readonly operatorClientSecret: string;
  readonly providerClientId: string;
  readonly providerClientSecret: string;
  readonly providerId: string;
  readonly up: boolean;
}

export interface LoadWallet {
  readonly walletId: string;
  readonly playerId: string;
  readonly currency: string;
}

export interface LatencySummary {
  readonly avg: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

export interface ScenarioResult {
  readonly scenario: Scenario;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly wallets: number;
  readonly k6ExitCode: number;
  readonly testRunDurationMs: number;
  readonly requests: number;
  readonly throughputPerSecond: number;
  readonly latencyMs: LatencySummary;
  readonly statusCounts: Readonly<Record<string, number>>;
  readonly unexpectedResponses: number;
  readonly errorRate: number;
  readonly kinds: Readonly<Record<string, number>>;
  readonly resends: number;
  readonly replays: number;
  readonly outboxLagMaxSeconds: number | null;
  readonly lockConflicts: Readonly<Record<string, number>> | null;
}

export interface WalletCheck {
  readonly walletId: string;
  readonly consistent: boolean;
  readonly storedBalance: MoneyProps;
  readonly checkedEntries: number;
}

export interface ReconciliationResult {
  readonly wallets: number;
  readonly consistent: number;
  readonly inconsistentWallets: readonly string[];
  readonly negativeWallets: readonly string[];
  readonly checkedEntries: number;
}

export interface LoadTestReport {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly duration: string;
  readonly k6Image: string;
  readonly environment: Readonly<Record<string, string | number>>;
  readonly scenarios: readonly ScenarioResult[];
  readonly reconciliation: ReconciliationResult;
  readonly prometheusAvailable: boolean;
  readonly passed: boolean;
}

export class LoadTestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LoadTestError';
  }
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
});

const createdWalletSchema = z.union([
  z.object({ id: z.string() }).transform((body) => ({ walletId: body.id })),
  z.object({ walletId: z.string() }),
]);

const reconciliationSchema = z.object({
  consistent: z.boolean(),
  checkedEntries: z.number().int(),
  storedBalance: z.object({ amount: z.string(), currency: z.string() }),
});

const k6SummarySchema = z.object({
  state: z.object({ testRunDurationMs: z.number() }),
  metrics: z.record(z.object({ values: z.record(z.number()) })),
});

const prometheusVectorSchema = z.object({
  status: z.literal('success'),
  data: z.object({
    result: z.array(
      z.object({
        metric: z.record(z.string()),
        value: z.tuple([z.number(), z.string()]),
      }),
    ),
  }),
});

const containerNetworksSchema = z.record(z.unknown());

type K6Summary = z.infer<typeof k6SummarySchema>;

export const durationSeconds = (text: string): number => {
  const match = DURATION_PATTERN.exec(text);
  const seconds =
    match === null
      ? 0
      : Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  if (seconds < 2) {
    throw new LoadTestError(
      `--duration must look like 60s, 2m or 1m30s and last at least 2s, got ${text}`,
    );
  }
  return seconds;
};

const describeFailure = (error: unknown): string => {
  if (error instanceof LoadTestError) {
    return error.message;
  }
  if (!(error instanceof Error)) {
    return 'unknown error';
  }
  return error.message === '' ? error.name : `${error.name}: ${error.message}`;
};

const roundTo = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const expectStatus = (response: Response, accepted: readonly number[], what: string): void => {
  if (!accepted.includes(response.status)) {
    throw new LoadTestError(`${what} answered HTTP ${String(response.status)}`);
  }
};

const parseJson = async <T>(
  response: Response,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  what: string,
): Promise<T> => {
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    throw new LoadTestError(`unexpected ${what} response body`);
  }
  return parsed.data;
};

const inBatches = async <T, R>(
  items: readonly T[],
  work: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = [];
  for (const batch of chunk(items, HTTP_CONCURRENCY)) {
    results.push(...(await Promise.all(batch.map(work))));
  }
  return results;
};

const run = async (
  command: readonly string[],
  what: string,
): Promise<{ readonly exitCode: number; readonly stdout: string }> => {
  const child = Bun.spawn([...command], { stdout: 'pipe', stderr: 'inherit' });
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (exitCode !== 0) {
    throw new LoadTestError(`${what} exited with code ${String(exitCode)}`);
  }
  return { exitCode, stdout };
};

class TokenSource {
  private token: string | undefined;
  private expiresAt = 0;

  constructor(
    private readonly tokenUrl: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  async bearer(): Promise<string> {
    if (this.token === undefined || Date.now() >= this.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
      const response = await fetch(this.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.clientId,
          client_secret: this.clientSecret,
        }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      expectStatus(response, [200], 'token endpoint');
      const body = await parseJson(response, tokenResponseSchema, 'token');
      this.token = body.access_token;
      this.expiresAt = Date.now() + body.expires_in * 1000;
    }
    return `Bearer ${this.token}`;
  }
}

class OperatorApi {
  constructor(
    private readonly apiUrl: string,
    private readonly tokens: TokenSource,
    private readonly correlationId: string,
  ) {}

  private async post(path: string, body?: unknown): Promise<Response> {
    for (let attempt = 1; ; attempt += 1) {
      const response = await this.postOnce(path, body);
      if (response.status !== SERVICE_UNAVAILABLE || attempt >= UNAVAILABLE_RETRIES) {
        return response;
      }
      await response.body?.cancel();
      await Bun.sleep(UNAVAILABLE_BACKOFF_MS * attempt);
    }
  }

  private async postOnce(path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: await this.tokens.bearer(),
      'x-correlation-id': this.correlationId,
    };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    return fetch(`${this.apiUrl}${path}`, {
      method: 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  }

  async createWallet(initialBalance: MoneyProps): Promise<LoadWallet> {
    const playerId = Bun.randomUUIDv7();
    const response = await this.post('/wallets', { playerId, initialBalance });
    expectStatus(response, [201, 409], 'wallet creation');
    const created = await parseJson(response, createdWalletSchema, 'wallet creation');
    return { walletId: created.walletId, playerId, currency: initialBalance.currency };
  }

  async reconcile(walletId: string): Promise<WalletCheck> {
    const response = await this.post(`/wallets/${walletId}/reconciliation`);
    expectStatus(response, [200], 'wallet reconciliation');
    const report = await parseJson(response, reconciliationSchema, 'wallet reconciliation');
    return {
      walletId,
      consistent: report.consistent,
      storedBalance: report.storedBalance,
      checkedEntries: report.checkedEntries,
    };
  }
}

const isReady = async (apiUrl: string): Promise<boolean> => {
  try {
    const response = await fetch(`${apiUrl}/health/ready`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
};

const ensureCompose = async (options: LoadTestOptions): Promise<void> => {
  if (await isReady(options.apiUrl)) {
    return;
  }
  if (!options.up) {
    throw new LoadTestError(`the api at ${options.apiUrl} is not ready and --no-up was given`);
  }
  console.log('compose is not ready, starting it with the observability profile');
  await run(
    ['docker', 'compose', '--profile', 'observability', 'up', '-d', '--wait'],
    'docker compose up',
  );
  if (!(await isReady(options.apiUrl))) {
    throw new LoadTestError(`the api at ${options.apiUrl} is still not ready after compose up`);
  }
};

const composeNetwork = async (): Promise<string> => {
  const { stdout: containerIds } = await run(
    ['docker', 'compose', 'ps', '-q', 'nginx'],
    'docker compose ps',
  );
  const containerId = containerIds.trim().split('\n')[0] ?? '';
  if (containerId === '') {
    throw new LoadTestError('the nginx container of the compose project is not running');
  }
  const { stdout } = await run(
    ['docker', 'inspect', '--format', '{{json .NetworkSettings.Networks}}', containerId],
    'docker inspect',
  );
  const network = Object.keys(containerNetworksSchema.parse(JSON.parse(stdout)))[0];
  if (network === undefined) {
    throw new LoadTestError('the nginx container is attached to no network');
  }
  return network;
};

const dockerVersion = async (): Promise<string> => {
  try {
    const { stdout } = await run(
      ['docker', 'version', '--format', '{{.Server.Version}}'],
      'docker version',
    );
    return stdout.trim();
  } catch {
    return 'unknown';
  }
};

const extractSummary = (stdout: string): K6Summary => {
  const start = stdout.lastIndexOf(SUMMARY_START);
  const end = stdout.lastIndexOf(SUMMARY_END);
  if (start === -1 || end < start) {
    throw new LoadTestError('k6 printed no summary');
  }
  const parsed = k6SummarySchema.safeParse(
    JSON.parse(stdout.slice(start + SUMMARY_START.length, end)),
  );
  if (!parsed.success) {
    throw new LoadTestError('k6 printed a summary in an unexpected shape');
  }
  return parsed.data;
};

const metricValue = (summary: K6Summary, metric: string, stat: string): number =>
  summary.metrics[metric]?.values[stat] ?? 0;

const statusCountsOf = (summary: K6Summary): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const [name, metric] of Object.entries(summary.metrics)) {
    const total = metric.values.count ?? 0;
    if (name.startsWith(STATUS_METRIC_PREFIX) && total > 0) {
      counts[name.slice(STATUS_METRIC_PREFIX.length)] = total;
    }
  }
  return counts;
};

const runK6 = async (
  options: LoadTestOptions,
  scenario: Scenario,
  network: string,
  wallets: readonly LoadWallet[],
  runId: string,
): Promise<{ readonly exitCode: number; readonly summary: K6Summary }> => {
  const inputDir = await mkdtemp(join(tmpdir(), 'jungle-load-'));
  try {
    await chmod(inputDir, 0o755);
    const walletsFile = join(inputDir, 'wallets.json');
    await writeFile(walletsFile, JSON.stringify(wallets));
    await chmod(walletsFile, 0o644);
    const variables = {
      DURATION: options.duration,
      API_URL: options.k6ApiUrl,
      TOKEN_URL: options.k6TokenUrl,
      CLIENT_ID: options.providerClientId,
      CLIENT_SECRET: options.providerClientSecret,
      PROVIDER_ID: options.providerId,
      RUN_ID: runId,
      WALLETS_FILE: '/input/wallets.json',
    };
    const child = Bun.spawn(
      [
        'docker',
        'run',
        '--rm',
        '--network',
        network,
        '-v',
        `${resolve('infra/k6')}:/scripts:ro,z`,
        '-v',
        `${inputDir}:/input:ro,z`,
        ...Object.entries(variables).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
        K6_IMAGE,
        'run',
        '--quiet',
        `/scripts/${scenario}.js`,
      ],
      { stdout: 'pipe', stderr: 'inherit' },
    );
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    return { exitCode, summary: extractSummary(stdout) };
  } finally {
    await rm(inputDir, { recursive: true, force: true });
  }
};

const prometheusQuery = async (
  prometheusUrl: string,
  query: string,
  at: Date,
): Promise<z.infer<typeof prometheusVectorSchema>['data']['result'] | null> => {
  try {
    const url = new URL('/api/v1/query', prometheusUrl);
    url.searchParams.set('query', query);
    url.searchParams.set('time', String(at.getTime() / 1000));
    const response = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const parsed = prometheusVectorSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.data.result : null;
  } catch {
    return null;
  }
};

const prometheusWindow = async (
  prometheusUrl: string,
  startedAt: Date,
  finishedAt: Date,
): Promise<{
  readonly outboxLagMaxSeconds: number | null;
  readonly lockConflicts: Record<string, number> | null;
}> => {
  const at = new Date(finishedAt.getTime() + PROMETHEUS_SETTLE_MS);
  const range = `${String(Math.ceil((at.getTime() - startedAt.getTime()) / 1000))}s`;
  const [lag, conflicts] = await Promise.all([
    prometheusQuery(prometheusUrl, `max(max_over_time(jungle_outbox_lag_seconds[${range}]))`, at),
    prometheusQuery(
      prometheusUrl,
      `sum by (type) (increase(jungle_lock_conflicts_total[${range}]))`,
      at,
    ),
  ]);
  const lockConflicts =
    conflicts === null
      ? null
      : Object.fromEntries(
          conflicts.map((sample) => [
            sample.metric.type ?? 'unknown',
            Math.round(Number(sample.value[1])),
          ]),
        );
  return {
    outboxLagMaxSeconds:
      lag === null ? null : lag.length === 0 ? 0 : roundTo(Number(lag[0]?.value[1] ?? 0), 3),
    lockConflicts,
  };
};

const scenarioResult = (
  scenario: Scenario,
  runId: string,
  window: { readonly startedAt: Date; readonly finishedAt: Date },
  wallets: number,
  k6: { readonly exitCode: number; readonly summary: K6Summary },
  observed: {
    readonly outboxLagMaxSeconds: number | null;
    readonly lockConflicts: Record<string, number> | null;
  },
): ScenarioResult => {
  const { summary } = k6;
  const latency = (stat: string): number =>
    roundTo(metricValue(summary, 'wager_request_duration', stat), 2);
  const requests = metricValue(summary, 'wager_request_duration', 'count');
  const statusCounts = statusCountsOf(summary);
  const unexpectedResponses = Object.entries(statusCounts)
    .filter(([status]) => !EXPECTED_STATUSES.has(status))
    .reduce((total, [, count]) => total + count, 0);
  const seconds = summary.state.testRunDurationMs / 1000;
  return {
    scenario,
    runId,
    startedAt: window.startedAt.toISOString(),
    finishedAt: window.finishedAt.toISOString(),
    wallets,
    k6ExitCode: k6.exitCode,
    testRunDurationMs: Math.round(summary.state.testRunDurationMs),
    requests,
    throughputPerSecond: seconds > 0 ? roundTo(requests / seconds, 1) : 0,
    latencyMs: {
      avg: latency('avg'),
      p50: latency('p(50)'),
      p95: latency('p(95)'),
      p99: latency('p(99)'),
      max: latency('max'),
    },
    statusCounts,
    unexpectedResponses,
    errorRate: requests > 0 ? roundTo(unexpectedResponses / requests, 4) : 0,
    kinds:
      scenario === 'hot-wallet'
        ? { BET: requests }
        : {
            BET: metricValue(summary, 'wager_kind_bet', 'count'),
            WIN: metricValue(summary, 'wager_kind_win', 'count'),
            LOSS: metricValue(summary, 'wager_kind_loss', 'count'),
          },
    resends: metricValue(summary, 'wager_resends', 'count'),
    replays: metricValue(summary, 'wager_replays', 'count'),
    outboxLagMaxSeconds: observed.outboxLagMaxSeconds,
    lockConflicts: observed.lockConflicts,
  };
};

const reconcileAll = async (
  api: OperatorApi,
  wallets: readonly LoadWallet[],
): Promise<ReconciliationResult> => {
  const checks = await inBatches(wallets, (wallet) => api.reconcile(wallet.walletId));
  return {
    wallets: checks.length,
    consistent: checks.filter((check) => check.consistent).length,
    inconsistentWallets: checks.filter((check) => !check.consistent).map((check) => check.walletId),
    negativeWallets: checks
      .filter((check) => check.storedBalance.amount.startsWith('-'))
      .map((check) => check.walletId),
    checkedEntries: checks.reduce((total, check) => total + check.checkedEntries, 0),
  };
};

export const isPassing = (
  scenarios: readonly ScenarioResult[],
  reconciliation: ReconciliationResult,
): boolean =>
  scenarios.every((result) => result.k6ExitCode === 0 && result.requests > 0) &&
  reconciliation.consistent === reconciliation.wallets &&
  reconciliation.negativeWallets.length === 0;

export const loadTest = async (options: LoadTestOptions): Promise<LoadTestReport> => {
  const startedAt = new Date();
  await ensureCompose(options);
  const network = await composeNetwork();
  const correlationId = Bun.randomUUIDv7();
  const api = new OperatorApi(
    options.apiUrl,
    new TokenSource(options.tokenUrl, options.operatorClientId, options.operatorClientSecret),
    correlationId,
  );
  const results: ScenarioResult[] = [];
  const usedWallets: LoadWallet[] = [];
  let prometheusAvailable = true;
  for (const scenario of options.scenarios) {
    const plan = SCENARIO_PLANS[scenario];
    console.log(`creating ${String(plan.wallets)} wallet(s) for ${scenario}`);
    const wallets = await inBatches(
      Array.from({ length: plan.wallets }, (_, index) => index),
      () => api.createWallet({ amount: plan.initialBalance, currency: CURRENCY }),
    );
    usedWallets.push(...wallets);
    const runId = Bun.randomUUIDv7();
    console.log(`running ${scenario} with ${K6_IMAGE} for ${options.duration}`);
    const scenarioStartedAt = new Date();
    const k6 = await runK6(options, scenario, network, wallets, runId);
    const scenarioFinishedAt = new Date();
    await Bun.sleep(PROMETHEUS_SETTLE_MS);
    const observed = await prometheusWindow(
      options.prometheusUrl,
      scenarioStartedAt,
      scenarioFinishedAt,
    );
    if (observed.outboxLagMaxSeconds === null || observed.lockConflicts === null) {
      prometheusAvailable = false;
    }
    results.push(
      scenarioResult(
        scenario,
        runId,
        { startedAt: scenarioStartedAt, finishedAt: scenarioFinishedAt },
        wallets.length,
        k6,
        observed,
      ),
    );
  }
  console.log(`reconciling ${String(usedWallets.length)} wallet(s)`);
  const reconciliation = await reconcileAll(api, usedWallets);
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    duration: options.duration,
    k6Image: K6_IMAGE,
    environment: {
      platform: `${platform()} ${release()}`,
      cpuModel: cpus()[0]?.model ?? 'unknown',
      cpus: cpus().length,
      memoryGiB: roundTo(totalmem() / 1024 ** 3, 1),
      docker: await dockerVersion(),
      bun: Bun.version,
    },
    scenarios: results,
    reconciliation,
    prometheusAvailable,
    passed: isPassing(results, reconciliation),
  };
};

const formatCount = (counts: Readonly<Record<string, number>> | null): string => {
  if (counts === null) {
    return 'n/a';
  }
  const entries = Object.entries(counts).sort(([left], [right]) => left.localeCompare(right));
  return entries.length === 0
    ? 'none'
    : entries.map(([key, total]) => `${key}=${String(total)}`).join(' ');
};

const formatRow = (cells: readonly string[], widths: readonly number[]): string =>
  cells.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join('  ');

export const formatReport = (report: LoadTestReport, file: string): string => {
  const header = [
    'scenario',
    'requests',
    'req/s',
    'p50 ms',
    'p95 ms',
    'p99 ms',
    'error rate',
    'outbox lag max s',
  ];
  const rows = report.scenarios.map((result) => [
    result.scenario,
    String(result.requests),
    String(result.throughputPerSecond),
    String(result.latencyMs.p50),
    String(result.latencyMs.p95),
    String(result.latencyMs.p99),
    `${String(roundTo(result.errorRate * 100, 2))}%`,
    result.outboxLagMaxSeconds === null ? 'n/a' : String(result.outboxLagMaxSeconds),
  ]);
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => (row[index] ?? '').length)),
  );
  const details = report.scenarios.flatMap((result) => [
    `${result.scenario}: statuses ${formatCount(result.statusCounts)}; kinds ${formatCount(result.kinds)}; resends=${String(result.resends)} replays=${String(result.replays)}; lock conflicts ${formatCount(result.lockConflicts)}`,
  ]);
  const { reconciliation } = report;
  return [
    formatRow(header, widths),
    ...rows.map((row) => formatRow(row, widths)),
    '',
    ...details,
    `reconciliation: ${String(reconciliation.consistent)}/${String(reconciliation.wallets)} consistent, ${String(reconciliation.negativeWallets.length)} negative balance(s), ${String(reconciliation.checkedEntries)} entries checked`,
    ...(report.prometheusAvailable
      ? []
      : ['prometheus: unreachable, start compose with --profile observability']),
    `results: ${file}`,
    `result: ${report.passed ? 'OK' : 'FAILED'}`,
  ].join('\n');
};

const isScenario = (value: string): value is Scenario =>
  SCENARIOS.some((scenario) => scenario === value);

const scenariosFrom = (value: string): Scenario[] => {
  if (value === 'all') {
    return [...SCENARIOS];
  }
  if (!isScenario(value)) {
    throw new LoadTestError(`--scenario must be all, ${SCENARIOS.join(' or ')}`);
  }
  return [value];
};

const withoutTrailingSlash = (url: string): string => url.replace(/\/+$/, '');

export const parseLoadTestArgs = (args: readonly string[]): LoadTestOptions => {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: {
      duration: { type: 'string', default: DEFAULT_DURATION },
      scenario: { type: 'string', default: 'all' },
      'api-url': { type: 'string', default: 'http://localhost:8080' },
      'token-url': {
        type: 'string',
        default: 'http://localhost:8081/realms/jungle/protocol/openid-connect/token',
      },
      'prometheus-url': { type: 'string', default: 'http://localhost:9090' },
      'k6-api-url': { type: 'string', default: 'http://nginx' },
      'k6-token-url': {
        type: 'string',
        default: 'http://keycloak:8080/realms/jungle/protocol/openid-connect/token',
      },
      'operator-client-id': { type: 'string', default: 'backoffice' },
      'operator-client-secret': { type: 'string', default: 'backoffice-secret' },
      'provider-client-id': { type: 'string', default: 'provider-a' },
      'provider-client-secret': { type: 'string', default: 'provider-a-secret' },
      'provider-id': { type: 'string', default: 'provider-a' },
      'no-up': { type: 'boolean', default: false },
    },
  });
  durationSeconds(values.duration);
  return {
    duration: values.duration,
    scenarios: scenariosFrom(values.scenario),
    apiUrl: withoutTrailingSlash(values['api-url']),
    tokenUrl: values['token-url'],
    prometheusUrl: withoutTrailingSlash(values['prometheus-url']),
    k6ApiUrl: withoutTrailingSlash(values['k6-api-url']),
    k6TokenUrl: values['k6-token-url'],
    operatorClientId: values['operator-client-id'],
    operatorClientSecret: values['operator-client-secret'],
    providerClientId: values['provider-client-id'],
    providerClientSecret: values['provider-client-secret'],
    providerId: values['provider-id'],
    up: !values['no-up'],
  };
};

const writeReport = async (report: LoadTestReport): Promise<string> => {
  await mkdir(RESULTS_DIR, { recursive: true });
  const file = join(RESULTS_DIR, `${report.startedAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
};

if (import.meta.main) {
  try {
    const report = await loadTest(parseLoadTestArgs(process.argv.slice(2)));
    const file = await writeReport(report);
    console.log(formatReport(report, file));
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    console.error(`load test failed: ${describeFailure(error)}`);
    process.exitCode = 1;
  }
}
