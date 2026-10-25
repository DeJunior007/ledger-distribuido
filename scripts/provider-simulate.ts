import { parseArgs } from 'node:util';
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { z } from 'zod';
import { chunk } from '@application/services/chunk';
import { Money } from '@domain/shared/money';
import type { MoneyProps } from '@domain/shared/money';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '@domain/wagering/wager-transaction-status';
import { createSqsClient } from '@infrastructure/messaging/sqs.client';
import type { SqsClientConfig } from '@infrastructure/messaging/sqs.client';
import type {
  RequestWagerKind,
  WagerTransactionData,
} from '@interfaces/http/schemas/wager-transaction.schema';
import { WAGER_TRANSACTION_REQUESTED } from '@interfaces/sqs/message-envelope.schema';
import type { WagerTransactionEnvelope } from '@interfaces/sqs/message-envelope.schema';

export const SCENARIOS = ['duplicates', 'out-of-order', 'concurrent', 'mixed'] as const;

export type Scenario = (typeof SCENARIOS)[number];

export const SIMULATED_PROVIDER_ID = 'provider-a';
export const SIMULATED_GAME_ID = 'sim-slot';
export const SIMULATED_CURRENCY = 'BRL';
export const WALLET_RESERVE = '100.00';
export const SETTLE_TIMEOUT_MS = 120_000;
export const POLL_INTERVAL_MS = 500;
export const HTTP_TIMEOUT_MS = 10_000;
export const LOOKUP_BATCH_SIZE = 20;
export const MAX_WALLETS = 100;
export const MAX_COUNT = 500;

const TOKEN_REFRESH_MARGIN_MS = 30_000;
const BET_AMOUNTS = ['5.00', '12.50', '20.00', '7.25', '30.00'] as const;
const WIN_AMOUNTS = ['10.00', '25.00', '40.00', '14.50', '60.00'] as const;
const ZERO_AMOUNT = '0.00';
const PROCESSED_LABEL: string = WagerTransactionStatus.Processed;

export interface SimulateOptions {
  readonly scenario: Scenario;
  readonly wallets: number;
  readonly count: number;
  readonly apiUrl: string;
  readonly tokenUrl: string;
  readonly sqsEndpoint: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface SimulationStep {
  readonly key: string;
  readonly round: number;
  readonly kind: RequestWagerKind;
  readonly amount: string;
  readonly reference?: string;
}

export interface SimulationDelivery {
  readonly stepKey: string;
  readonly messageSuffix: string;
}

export interface WalletScript {
  readonly steps: readonly SimulationStep[];
  readonly deliveries: readonly SimulationDelivery[];
}

export interface WalletOutcome {
  readonly walletId: string;
  readonly balance: MoneyProps;
  readonly expectedBalance: MoneyProps;
  readonly consistent: boolean;
  readonly checkedEntries: number;
}

export interface SimulationSummary {
  readonly scenario: Scenario;
  readonly runId: string;
  readonly published: number;
  readonly transactions: number;
  readonly statuses: Readonly<Record<string, number>>;
  readonly unsettled: number;
  readonly queueDrained: boolean;
  readonly wallets: readonly WalletOutcome[];
}

interface PlannedWallet {
  readonly index: number;
  readonly walletId: string;
  readonly playerId: string;
  readonly expectedBalance: Money;
  readonly transactions: readonly WagerTransactionData[];
  readonly publications: readonly WagerTransactionEnvelope[];
}

interface Lookup {
  readonly status: WagerTransactionStatus;
  readonly failureCode: string | undefined;
}

export class SimulationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SimulationError';
  }
}

const moneyPropsSchema = z.object({ amount: z.string(), currency: z.string() });

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
});

const createdWalletSchema = z.object({ id: z.string(), playerId: z.string() });

const walletBalanceSchema = z.object({ id: z.string(), balance: moneyPropsSchema });

const transactionLookupSchema = z.object({
  status: z.nativeEnum(WagerTransactionStatus),
  failureCode: z.string().optional(),
});

const reconciliationSchema = z.object({
  consistent: z.boolean(),
  checkedEntries: z.number().int(),
});

const amountAt = (amounts: readonly string[], position: number): string =>
  amounts[position % amounts.length] ?? ZERO_AMOUNT;

const range = (size: number): number[] => Array.from({ length: size }, (_, index) => index);

const step = (
  key: string,
  round: number,
  kind: RequestWagerKind,
  amount: string,
  reference?: string,
): SimulationStep =>
  reference === undefined ? { key, round, kind, amount } : { key, round, kind, amount, reference };

const inOrder = (steps: readonly SimulationStep[]): SimulationDelivery[] =>
  steps.map((entry) => ({ stepKey: entry.key, messageSuffix: '' }));

const mixedRound = (round: number): SimulationStep[] => {
  const bet = `r${String(round)}-bet`;
  const betAmount = amountAt(BET_AMOUNTS, round);
  const winAmount = amountAt(WIN_AMOUNTS, round);
  const opening = step(bet, round, WagerTransactionKind.Bet, betAmount);
  switch (round % 5) {
    case 0:
      return [
        opening,
        step(`r${String(round)}-win`, round, WagerTransactionKind.Win, winAmount, bet),
      ];
    case 1:
      return [
        opening,
        step(`r${String(round)}-loss`, round, WagerTransactionKind.Loss, ZERO_AMOUNT, bet),
      ];
    case 2:
      return [
        opening,
        step(`r${String(round)}-refund`, round, WagerTransactionKind.Refund, betAmount, bet),
      ];
    case 3:
      return [
        opening,
        step(`r${String(round)}-win`, round, WagerTransactionKind.Win, winAmount, bet),
        step(
          `r${String(round)}-rollback`,
          round,
          WagerTransactionKind.Rollback,
          winAmount,
          `r${String(round)}-win`,
        ),
      ];
    default:
      return [
        opening,
        step(`r${String(round)}-rollback`, round, WagerTransactionKind.Rollback, betAmount, bet),
      ];
  }
};

const outOfOrderRound = (round: number): SimulationStep[] => {
  const bet = `r${String(round)}-bet`;
  const amount = amountAt(BET_AMOUNTS, round);
  const reversal =
    round % 2 === 0
      ? step(`r${String(round)}-refund`, round, WagerTransactionKind.Refund, amount, bet)
      : step(`r${String(round)}-rollback`, round, WagerTransactionKind.Rollback, amount, bet);
  return [step(bet, round, WagerTransactionKind.Bet, amount), reversal];
};

export const buildWalletScript = (scenario: Scenario, count: number): WalletScript => {
  switch (scenario) {
    case 'duplicates': {
      const bet = step('r0-bet', 0, WagerTransactionKind.Bet, amountAt(BET_AMOUNTS, 0));
      const sameMessage = range(count).map(() => ({ stepKey: bet.key, messageSuffix: '' }));
      const newMessages = range(count).map((copy) => ({
        stepKey: bet.key,
        messageSuffix: `-copy${String(copy + 1)}`,
      }));
      return { steps: [bet], deliveries: [...sameMessage, ...newMessages] };
    }
    case 'out-of-order': {
      const steps = range(count).flatMap(outOfOrderRound);
      const reversals = steps.filter((entry) => entry.kind !== WagerTransactionKind.Bet);
      const bets = steps.filter((entry) => entry.kind === WagerTransactionKind.Bet);
      return { steps, deliveries: inOrder([...reversals, ...bets]) };
    }
    case 'concurrent': {
      const steps = range(count).map((round) =>
        step(
          `r${String(round)}-bet`,
          round,
          WagerTransactionKind.Bet,
          amountAt(BET_AMOUNTS, round),
        ),
      );
      return { steps, deliveries: inOrder(steps) };
    }
    case 'mixed': {
      const steps = range(count).flatMap(mixedRound);
      return { steps, deliveries: inOrder(steps) };
    }
  }
};

const moneyOf = (amount: string): Money => Money.from({ amount, currency: SIMULATED_CURRENCY });

export const requiredInitialBalance = (script: WalletScript): Money =>
  script.steps
    .filter((entry) => entry.kind === WagerTransactionKind.Bet)
    .reduce((total, entry) => total.add(moneyOf(entry.amount)), moneyOf(WALLET_RESERVE));

export const expectedFinalBalance = (script: WalletScript, initial: Money): Money => {
  const kindByKey = new Map(script.steps.map((entry) => [entry.key, entry.kind]));
  return script.steps.reduce((balance, entry) => {
    const value = moneyOf(entry.amount);
    switch (entry.kind) {
      case WagerTransactionKind.Bet:
        return balance.subtract(value);
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return balance.add(value);
      case WagerTransactionKind.Rollback:
        return kindByKey.get(entry.reference ?? '') === WagerTransactionKind.Bet
          ? balance.add(value)
          : balance.subtract(value);
      case WagerTransactionKind.Loss:
        return balance;
    }
  }, initial);
};

const externalIdOf = (runId: string, walletIndex: number, key: string): string =>
  `sim-${runId}-w${String(walletIndex)}-${key}`;

const materialize = (
  runId: string,
  wallet: { readonly index: number; readonly walletId: string; readonly playerId: string },
  entry: SimulationStep,
): WagerTransactionData => {
  const externalTransactionId = externalIdOf(runId, wallet.index, entry.key);
  const data: WagerTransactionData = {
    providerId: SIMULATED_PROVIDER_ID,
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: `sim-${runId}-w${String(wallet.index)}-r${String(entry.round)}`,
    gameId: SIMULATED_GAME_ID,
    kind: entry.kind,
    money: { amount: entry.amount, currency: SIMULATED_CURRENCY },
    idempotencyKey: `idem-${externalTransactionId}`,
  };
  return entry.reference === undefined
    ? data
    : {
        ...data,
        referenceExternalTransactionId: externalIdOf(runId, wallet.index, entry.reference),
      };
};

const envelopeOf = (
  data: WagerTransactionData,
  messageSuffix: string,
): WagerTransactionEnvelope => ({
  messageId: `msg-${data.externalTransactionId}${messageSuffix}`,
  type: WAGER_TRANSACTION_REQUESTED,
  occurredAt: new Date().toISOString(),
  data,
});

const describeFailure = (error: unknown): string => {
  if (error instanceof SimulationError) {
    return error.message;
  }
  if (!(error instanceof Error)) {
    return 'unknown error';
  }
  const code: unknown = Reflect.get(error, 'code');
  const label = typeof code === 'string' ? `${error.name} (${code})` : error.name;
  return error.message === '' ? label : `${label}: ${error.message}`;
};

const parseJson = async <T>(
  response: Response,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  description: string,
): Promise<T> => {
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    throw new SimulationError(`unexpected ${description} response body`);
  }
  return parsed.data;
};

const expectStatus = (
  response: Response,
  accepted: readonly number[],
  description: string,
): void => {
  if (!accepted.includes(response.status)) {
    throw new SimulationError(`${description} answered HTTP ${String(response.status)}`);
  }
};

class TokenSource {
  private token: string | undefined;
  private expiresAt = 0;

  constructor(private readonly options: SimulateOptions) {}

  async bearer(): Promise<string> {
    if (this.token === undefined || Date.now() >= this.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
      const response = await fetch(this.options.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
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

class WalletApi {
  constructor(
    private readonly apiUrl: string,
    private readonly tokens: TokenSource,
    private readonly correlationId: string,
  ) {}

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: await this.tokens.bearer(),
      'x-correlation-id': this.correlationId,
    };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    return fetch(`${this.apiUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  }

  async createWallet(playerId: string, initialBalance: MoneyProps): Promise<string> {
    const response = await this.call('POST', '/wallets', { playerId, initialBalance });
    expectStatus(response, [200, 201], 'wallet creation');
    return (await parseJson(response, createdWalletSchema, 'wallet creation')).id;
  }

  async balanceOf(walletId: string): Promise<MoneyProps> {
    const response = await this.call('GET', `/wallets/${walletId}`);
    expectStatus(response, [200], 'wallet lookup');
    return (await parseJson(response, walletBalanceSchema, 'wallet lookup')).balance;
  }

  async reconcile(walletId: string): Promise<z.infer<typeof reconciliationSchema>> {
    const response = await this.call('POST', `/wallets/${walletId}/reconciliation`);
    expectStatus(response, [200], 'wallet reconciliation');
    return parseJson(response, reconciliationSchema, 'wallet reconciliation');
  }

  async transaction(externalTransactionId: string): Promise<Lookup | undefined> {
    const response = await this.call(
      'GET',
      `/providers/${SIMULATED_PROVIDER_ID}/wagering/transactions/${encodeURIComponent(externalTransactionId)}`,
    );
    if (response.status === 404) {
      await response.body?.cancel();
      return undefined;
    }
    expectStatus(response, [200], 'transaction lookup');
    const body = await parseJson(response, transactionLookupSchema, 'transaction lookup');
    return { status: body.status, failureCode: body.failureCode };
  }
}

export type SimulatorSqsConfig = SqsClientConfig & { readonly WAGER_QUEUE_NAME: string };

export const sqsConfigFrom = (
  env: Record<string, string | undefined>,
  endpoint: string,
): SimulatorSqsConfig => {
  const read = (name: string, fallback: string): string => {
    const value = env[name];
    return value === undefined || value === '' ? fallback : value;
  };
  return {
    SQS_ENDPOINT: endpoint,
    AWS_REGION: read('AWS_REGION', 'us-east-1'),
    AWS_ACCESS_KEY_ID: read('AWS_ACCESS_KEY_ID', 'test'),
    AWS_SECRET_ACCESS_KEY: read('AWS_SECRET_ACCESS_KEY', 'test'),
    SQS_REQUEST_TIMEOUT_MS: Number(read('SQS_REQUEST_TIMEOUT_MS', '5000')),
    SQS_RECEIVE_WAIT_SECONDS: Number(read('SQS_RECEIVE_WAIT_SECONDS', '20')),
    WAGER_QUEUE_NAME: read('WAGER_QUEUE_NAME', 'wager-transactions.fifo'),
  };
};

const queueUrlOf = async (client: SQSClient, queueName: string): Promise<string> => {
  const found = await client.send(new GetQueueUrlCommand({ QueueName: queueName }));
  if (found.QueueUrl === undefined) {
    throw new SimulationError(`queue ${queueName} not found`);
  }
  return found.QueueUrl;
};

const publish = async (
  client: SQSClient,
  queueUrl: string,
  correlationId: string,
  envelope: WagerTransactionEnvelope,
): Promise<void> => {
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(envelope),
      MessageGroupId: envelope.data.walletId,
      MessageDeduplicationId: envelope.messageId,
      MessageAttributes: { correlationId: { DataType: 'String', StringValue: correlationId } },
    }),
  );
};

const queueIsEmpty = async (client: SQSClient, queueUrl: string): Promise<boolean> => {
  const result = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  const visible = result.Attributes?.ApproximateNumberOfMessages ?? '0';
  const inFlight = result.Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0';
  return visible === '0' && inFlight === '0';
};

const planWallets = async (
  api: WalletApi,
  options: SimulateOptions,
  runId: string,
): Promise<PlannedWallet[]> => {
  const script = buildWalletScript(options.scenario, options.count);
  const initial = requiredInitialBalance(script);
  const stepByKey = new Map(script.steps.map((entry) => [entry.key, entry]));
  return Promise.all(
    range(options.wallets).map(async (index): Promise<PlannedWallet> => {
      const playerId = Bun.randomUUIDv7();
      const walletId = await api.createWallet(playerId, initial.toJSON());
      const wallet = { index, walletId, playerId };
      const transactions = script.steps.map((entry) => materialize(runId, wallet, entry));
      const publications = script.deliveries.map((delivery) => {
        const entry = stepByKey.get(delivery.stepKey);
        if (entry === undefined) {
          throw new SimulationError(`delivery for unknown step ${delivery.stepKey}`);
        }
        return envelopeOf(materialize(runId, wallet, entry), delivery.messageSuffix);
      });
      return {
        index,
        walletId,
        playerId,
        expectedBalance: expectedFinalBalance(script, initial),
        transactions,
        publications,
      };
    }),
  );
};

const publishAll = async (
  client: SQSClient,
  queueUrl: string,
  correlationId: string,
  scenario: Scenario,
  wallets: readonly PlannedWallet[],
): Promise<number> => {
  const send = (envelope: WagerTransactionEnvelope): Promise<void> =>
    publish(client, queueUrl, correlationId, envelope);
  if (scenario === 'concurrent') {
    await Promise.all(wallets.flatMap((wallet) => wallet.publications.map(send)));
  } else {
    await Promise.all(
      wallets.map(async (wallet) => {
        for (const envelope of wallet.publications) {
          await send(envelope);
        }
      }),
    );
  }
  return wallets.reduce((total, wallet) => total + wallet.publications.length, 0);
};

const isSettled = (lookup: Lookup | undefined): lookup is Lookup =>
  lookup !== undefined &&
  lookup.status !== WagerTransactionStatus.Pending &&
  lookup.status !== WagerTransactionStatus.PendingReference;

const awaitSettlement = async (
  api: WalletApi,
  externalIds: readonly string[],
  deadline: number,
): Promise<Map<string, Lookup>> => {
  const settled = new Map<string, Lookup>();
  let open = [...externalIds];
  while (open.length > 0) {
    for (const batch of chunk(open, LOOKUP_BATCH_SIZE)) {
      const lookups = await Promise.all(batch.map((id) => api.transaction(id)));
      batch.forEach((id, position) => {
        const lookup = lookups[position];
        if (isSettled(lookup)) {
          settled.set(id, lookup);
        }
      });
    }
    open = open.filter((id) => !settled.has(id));
    if (open.length === 0 || Date.now() >= deadline) {
      break;
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  return settled;
};

const awaitDrain = async (
  client: SQSClient,
  queueUrl: string,
  deadline: number,
): Promise<boolean> => {
  for (;;) {
    if (await queueIsEmpty(client, queueUrl)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
};

const statusLabel = (lookup: Lookup): string =>
  lookup.failureCode === undefined ? lookup.status : `${lookup.status}/${lookup.failureCode}`;

export const simulate = async (
  options: SimulateOptions,
  env: Record<string, string | undefined>,
): Promise<SimulationSummary> => {
  const runId = Bun.randomUUIDv7();
  const api = new WalletApi(options.apiUrl, new TokenSource(options), runId);
  const sqsConfig = sqsConfigFrom(env, options.sqsEndpoint);
  const client = createSqsClient(sqsConfig, sqsConfig.SQS_REQUEST_TIMEOUT_MS);
  try {
    const queueUrl = await queueUrlOf(client, sqsConfig.WAGER_QUEUE_NAME);
    const wallets = await planWallets(api, options, runId);
    const published = await publishAll(client, queueUrl, runId, options.scenario, wallets);
    const externalIds = wallets.flatMap((wallet) =>
      wallet.transactions.map((transaction) => transaction.externalTransactionId),
    );
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    const settled = await awaitSettlement(api, externalIds, deadline);
    const queueDrained = await awaitDrain(client, queueUrl, deadline);
    const statuses: Record<string, number> = {};
    for (const lookup of settled.values()) {
      const label = statusLabel(lookup);
      statuses[label] = (statuses[label] ?? 0) + 1;
    }
    const outcomes = await Promise.all(
      wallets.map(async (wallet): Promise<WalletOutcome> => {
        const report = await api.reconcile(wallet.walletId);
        return {
          walletId: wallet.walletId,
          balance: await api.balanceOf(wallet.walletId),
          expectedBalance: wallet.expectedBalance.toJSON(),
          consistent: report.consistent,
          checkedEntries: report.checkedEntries,
        };
      }),
    );
    return {
      scenario: options.scenario,
      runId,
      published,
      transactions: externalIds.length,
      statuses,
      unsettled: externalIds.length - settled.size,
      queueDrained,
      wallets: outcomes,
    };
  } finally {
    client.destroy();
  }
};

const sameMoney = (left: MoneyProps, right: MoneyProps): boolean =>
  left.amount === right.amount && left.currency === right.currency;

export const isSuccessful = (summary: SimulationSummary): boolean =>
  summary.unsettled === 0 &&
  summary.queueDrained &&
  Object.keys(summary.statuses).every((label) => label === PROCESSED_LABEL) &&
  summary.wallets.every(
    (wallet) => wallet.consistent && sameMoney(wallet.balance, wallet.expectedBalance),
  );

export const formatSummary = (summary: SimulationSummary): string => {
  const statuses = Object.entries(summary.statuses)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, total]) => `${label}=${String(total)}`)
    .join(' ');
  const consistent = summary.wallets.filter((wallet) => wallet.consistent).length;
  const percent =
    summary.wallets.length === 0 ? 100 : Math.round((consistent * 100) / summary.wallets.length);
  const walletLines = summary.wallets.map(
    (wallet) =>
      `  wallet ${wallet.walletId}: balance=${wallet.balance.amount} ${wallet.balance.currency} expected=${wallet.expectedBalance.amount} ${wallet.expectedBalance.currency} entries=${String(wallet.checkedEntries)} ${wallet.consistent ? 'consistent' : 'INCONSISTENT'}`,
  );
  return [
    `provider simulate: scenario=${summary.scenario} run=${summary.runId}`,
    `  published=${String(summary.published)} transactions=${String(summary.transactions)} unsettled=${String(summary.unsettled)} queueDrained=${String(summary.queueDrained)}`,
    `  statuses: ${statuses.length > 0 ? statuses : 'none'}`,
    ...walletLines,
    `reconciliation: ${String(consistent)}/${String(summary.wallets.length)} consistent (${String(percent)}%)`,
    `result: ${isSuccessful(summary) ? 'OK' : 'FAILED'}`,
  ].join('\n');
};

const isScenario = (value: string): value is Scenario =>
  SCENARIOS.some((scenario) => scenario === value);

const positiveIntegerFlag = (
  value: string | undefined,
  name: string,
  fallback: number,
  max: number,
): number => {
  if (value === undefined) {
    return fallback;
  }
  if (!/^[1-9]\d*$/.test(value) || Number(value) > max) {
    throw new SimulationError(`--${name} must be an integer between 1 and ${String(max)}`);
  }
  return Number(value);
};

const withoutTrailingSlash = (url: string): string => url.replace(/\/+$/, '');

export const parseSimulateArgs = (args: readonly string[]): SimulateOptions => {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: {
      scenario: { type: 'string' },
      wallets: { type: 'string' },
      count: { type: 'string' },
      'api-url': { type: 'string', default: 'http://localhost:8080' },
      'token-url': {
        type: 'string',
        default: 'http://localhost:8081/realms/jungle/protocol/openid-connect/token',
      },
      'sqs-endpoint': { type: 'string', default: 'http://localhost:4566' },
      'client-id': { type: 'string', default: 'backoffice' },
      'client-secret': { type: 'string', default: 'backoffice-secret' },
    },
  });
  const scenario = values.scenario;
  if (scenario === undefined || !isScenario(scenario)) {
    throw new SimulationError(`--scenario must be one of ${SCENARIOS.join(', ')}`);
  }
  return {
    scenario,
    wallets: positiveIntegerFlag(values.wallets, 'wallets', 3, MAX_WALLETS),
    count: positiveIntegerFlag(values.count, 'count', 5, MAX_COUNT),
    apiUrl: withoutTrailingSlash(values['api-url']),
    tokenUrl: values['token-url'],
    sqsEndpoint: values['sqs-endpoint'],
    clientId: values['client-id'],
    clientSecret: values['client-secret'],
  };
};

if (import.meta.main) {
  try {
    const summary = await simulate(parseSimulateArgs(process.argv.slice(2)), process.env);
    console.log(formatSummary(summary));
    process.exitCode = isSuccessful(summary) ? 0 : 1;
  } catch (error) {
    console.error(`provider simulate failed: ${describeFailure(error)}`);
    process.exitCode = 1;
  }
}
