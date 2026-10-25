import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Client } from 'pg';
import { z } from 'zod';
import { createSqsClient } from '@infrastructure/messaging/sqs.client';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import type { RequestWagerKind } from '@interfaces/http/schemas/wager-transaction.schema';
import { buildEnvelope, countMessages, publishEnvelope } from '@test/support/sqs';
import type { WagerTransactionEnvelope } from '@test/support/sqs';
import { waitFor } from '@test/support/wait-for';

type KeycloakClient = 'provider-a' | 'backoffice';
type Channel = 'http' | 'queue';

const TOKEN_URL = 'http://localhost:8081/realms/jungle/protocol/openid-connect/token';
const API_URL = 'http://localhost:8080';
const SQS_ENDPOINT = 'http://localhost:4566';
const DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/jungle';
const WAGER_QUEUE_NAME = 'wager-transactions.fifo';
const WAGER_DLQ_NAME = 'wager-transactions-dlq.fifo';
const WAGER_CONSUMER = 'wager-transactions-consumer';
const PROVIDER_ID = 'provider-a';
const GAME_ID = 'failover-game';
const CURRENCY = 'BRL';
const INITIAL_BALANCE = '1000.00';
const BET_AMOUNT = '1.00';
const WIN_AMOUNT = '2.00';
const LOSS_AMOUNT = '0.00';
const WALLET_COUNT = 6;
const HTTP_WORKERS_PER_WALLET = 2;
const QUEUE_PUBLISH_INTERVAL_MS = 150;
const WARMUP_MS = 4_000;
const OUTAGE_MS = 8_000;
const COOLDOWN_MS = 4_000;
const RETRYABLE_STATUSES: readonly number[] = [502, 503, 504];
const FINAL_STATUSES: readonly number[] = [200, 422];
const MAX_ATTEMPTS = 40;
const DEFAULT_RETRY_AFTER_SECONDS = 1;
const REQUEST_TIMEOUT_MS = 40_000;
const SQS_TIMEOUT_MS = 5_000;
const KILLED_INDEX = 2;
const READY_WAIT = { timeoutMs: 120_000, intervalMs: 1_000 } as const;
const DRAIN_WAIT = { timeoutMs: 180_000, intervalMs: 1_000 } as const;
const SERVICE_REPLICAS = {
  api: 3,
  consumer: 3,
  outbox: 2,
  scheduler: 2,
  'events-audit': 1,
} as const;

const tokenResponseSchema = z.object({ access_token: z.string().min(1) });
const createdWalletSchema = z.object({ id: z.string(), playerId: z.string() });
const outcomeSchema = z.object({ transactionId: z.string(), status: z.string() }).passthrough();
const walletViewSchema = z.object({ balance: z.object({ amount: z.string() }) }).passthrough();
const reconciliationSchema = z
  .object({ consistent: z.boolean(), chain: z.object({ valid: z.boolean() }).passthrough() })
  .passthrough();
const composeContainerSchema = z.object({ ID: z.string(), Labels: z.string() }).passthrough();
const readinessReportSchema = z.object({ code: z.number() }).passthrough();
const storedTransactionSchema = z.object({
  id: z.string(),
  externalId: z.string(),
  walletId: z.string(),
  kind: z.string(),
  status: z.string(),
  amount: z.string(),
  walletLegs: z.number(),
  houseLegs: z.number(),
});
const walletEntriesSchema = z.object({ walletId: z.string(), entries: z.number() });
const countSchema = z.object({ count: z.number() });

interface TestWallet {
  readonly id: string;
  readonly playerId: string;
}

interface Operation {
  readonly channel: Channel;
  readonly externalId: string;
  readonly walletId: string;
  readonly kind: RequestWagerKind;
  readonly amount: string;
}

interface HttpOutcome {
  readonly externalId: string;
  readonly httpStatus: number;
  readonly status: string;
  readonly transactionId: string;
  readonly attempts: number;
  readonly retried: readonly number[];
}

interface LoadState {
  httpRunning: boolean;
  queueRunning: boolean;
  readonly operations: Operation[];
  readonly httpOutcomes: HttpOutcome[];
  readonly envelopes: WagerTransactionEnvelope[];
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

const createWallet = async (operatorToken: string): Promise<TestWallet> => {
  const response = await fetch(`${API_URL}/wallets`, {
    method: 'POST',
    headers: headersFor(operatorToken),
    body: JSON.stringify({
      playerId: randomUUID(),
      initialBalance: { amount: INITIAL_BALANCE, currency: CURRENCY },
    }),
  });
  expect(response.status).toBe(201);
  return createdWalletSchema.parse(await response.json());
};

const retryDelayMs = (response: Response): number => {
  const header = Number(response.headers.get('Retry-After') ?? '');
  const seconds = Number.isFinite(header) && header > 0 ? header : DEFAULT_RETRY_AFTER_SECONDS;
  return seconds * 1000;
};

const operationBody = (
  operation: Operation,
  wallet: TestWallet,
  roundId: string,
  reference: string | undefined,
): Record<string, unknown> => ({
  providerId: PROVIDER_ID,
  externalTransactionId: operation.externalId,
  playerId: wallet.playerId,
  walletId: wallet.id,
  roundId,
  gameId: GAME_ID,
  kind: operation.kind,
  money: { amount: operation.amount, currency: CURRENCY },
  ...(reference === undefined ? {} : { referenceExternalTransactionId: reference }),
});

const submitUntilFinal = async (
  providerToken: string,
  operation: Operation,
  body: Record<string, unknown>,
): Promise<HttpOutcome> => {
  const idempotencyKey = `idem-${operation.externalId}`;
  const retried: number[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(`${API_URL}/wagering/transactions`, {
      method: 'POST',
      headers: headersFor(providerToken, { 'Idempotency-Key': idempotencyKey }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (RETRYABLE_STATUSES.includes(response.status)) {
      retried.push(response.status);
      await response.body?.cancel();
      await Bun.sleep(retryDelayMs(response));
      continue;
    }
    const outcome = outcomeSchema.parse(await response.json());
    return {
      externalId: operation.externalId,
      httpStatus: response.status,
      status: outcome.status,
      transactionId: outcome.transactionId,
      attempts: attempt,
      retried,
    };
  }
  return {
    externalId: operation.externalId,
    httpStatus: 0,
    status: 'UNRESOLVED',
    transactionId: '',
    attempts: MAX_ATTEMPTS,
    retried,
  };
};

const httpWorker = async (
  providerToken: string,
  wallet: TestWallet,
  worker: number,
  state: LoadState,
): Promise<void> => {
  for (let round = worker; state.httpRunning; round += 1) {
    const roundId = `failover-${randomUUID()}`;
    const bet: Operation = {
      channel: 'http',
      externalId: `ext-${randomUUID()}`,
      walletId: wallet.id,
      kind: WagerTransactionKind.Bet,
      amount: BET_AMOUNT,
    };
    const settle: Operation = {
      channel: 'http',
      externalId: `ext-${randomUUID()}`,
      walletId: wallet.id,
      kind: round % 2 === 0 ? WagerTransactionKind.Win : WagerTransactionKind.Loss,
      amount: round % 2 === 0 ? WIN_AMOUNT : LOSS_AMOUNT,
    };
    state.operations.push(bet);
    state.httpOutcomes.push(
      await submitUntilFinal(providerToken, bet, operationBody(bet, wallet, roundId, undefined)),
    );
    state.operations.push(settle);
    state.httpOutcomes.push(
      await submitUntilFinal(
        providerToken,
        settle,
        operationBody(settle, wallet, roundId, bet.externalId),
      ),
    );
  }
};

const queuePublisher = async (
  sqs: SQSClient,
  queueUrl: string,
  wallets: readonly TestWallet[],
  state: LoadState,
): Promise<void> => {
  for (let round = 0; state.queueRunning; round += 1) {
    const wallet = wallets[round % wallets.length];
    if (wallet === undefined) {
      return;
    }
    const roundId = `failover-queue-${randomUUID()}`;
    const bet = buildEnvelope({
      data: {
        providerId: PROVIDER_ID,
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId,
        gameId: GAME_ID,
        kind: WagerTransactionKind.Bet,
        money: { amount: BET_AMOUNT, currency: CURRENCY },
      },
    });
    const win = buildEnvelope({
      data: {
        providerId: PROVIDER_ID,
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId,
        gameId: GAME_ID,
        kind: WagerTransactionKind.Win,
        money: { amount: WIN_AMOUNT, currency: CURRENCY },
        referenceExternalTransactionId: bet.data.externalTransactionId,
      },
    });
    for (const envelope of [bet, win]) {
      await publishEnvelope(sqs, queueUrl, envelope);
      state.envelopes.push(envelope);
      state.operations.push({
        channel: 'queue',
        externalId: envelope.data.externalTransactionId,
        walletId: wallet.id,
        kind: envelope.data.kind,
        amount: envelope.data.money.amount,
      });
    }
    await Bun.sleep(QUEUE_PUBLISH_INTERVAL_MS);
  }
};

const run = async (command: readonly string[]): Promise<string> => {
  const child = Bun.spawn([...command], { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ command: command.join(' '), exitCode, stderr: exitCode === 0 ? '' : stderr }).toEqual({
    command: command.join(' '),
    exitCode: 0,
    stderr: '',
  });
  return stdout;
};

const containerId = async (service: string, index: number): Promise<string> => {
  const stdout = await run(['docker', 'compose', 'ps', '--all', '--format', 'json', service]);
  const marker = `com.docker.compose.container-number=${String(index)}`;
  const match = stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => composeContainerSchema.parse(JSON.parse(line)))
    .find((container) => container.Labels.split(',').includes(marker));
  expect(match).toBeDefined();
  return match?.ID ?? '';
};

const readinessScript = [
  `const response = await fetch('http://localhost:3000/health/ready');`,
  `process.stdout.write(JSON.stringify({ code: response.status }));`,
].join('\n');

const replicaReady = async (service: string, index: number): Promise<boolean> => {
  const child = Bun.spawn(
    [
      'docker',
      'compose',
      'exec',
      '-T',
      '--index',
      String(index),
      service,
      'bun',
      '-e',
      readinessScript,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (exitCode !== 0) {
    return false;
  }
  const parsed = readinessReportSchema.safeParse(JSON.parse(stdout));
  return parsed.success && parsed.data.code === 200;
};

const nginxReady = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${API_URL}/health/ready`);
    await response.body?.cancel();
    return response.status === 200;
  } catch {
    return false;
  }
};

const allReplicas = (): { readonly service: string; readonly index: number }[] =>
  Object.entries(SERVICE_REPLICAS).flatMap(([service, replicas]) =>
    Array.from({ length: replicas }, (_, offset) => ({ service, index: offset + 1 })),
  );

const queueUrlOf = async (sqs: SQSClient, name: string): Promise<string> => {
  const queue = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
  expect(queue.QueueUrl).toBeDefined();
  return queue.QueueUrl ?? '';
};

const STORED_SQL = `SELECT t.id, t.external_transaction_id AS "externalId", t.wallet_id AS "walletId",
       t.kind, t.status, t.amount::text AS amount,
       count(e.id) FILTER (WHERE e.account_kind = 'WALLET')::int AS "walletLegs",
       count(e.id) FILTER (WHERE e.account_kind = 'HOUSE')::int AS "houseLegs"
FROM wager_transactions t
LEFT JOIN ledger_entries e ON e.transaction_id = t.id
WHERE t.provider_id = $1 AND t.external_transaction_id = ANY($2::text[])
GROUP BY t.id`;

const WALLET_ENTRIES_SQL = `SELECT wallet_id AS "walletId", count(*)::int AS entries
FROM wallet_ledger_entries
WHERE wallet_id = ANY($1::uuid[])
GROUP BY wallet_id`;

const PROCESSED_MESSAGES_SQL = `SELECT count(*)::int AS count FROM inbox_messages
WHERE consumer_name = $1 AND message_id = ANY($2::text[]) AND processed_at IS NOT NULL`;

const PENDING_SQL = `SELECT count(*)::int AS count FROM wager_transactions
WHERE provider_id = $1 AND external_transaction_id = ANY($2::text[]) AND status = 'PENDING_REFERENCE'`;

const expectedLegs = (kind: string, status: string): { wallet: number; house: number } =>
  status === 'PROCESSED' && kind !== 'LOSS' ? { wallet: 1, house: 1 } : { wallet: 0, house: 0 };

const centsOf = (amount: string): bigint => BigInt(amount.replace('.', ''));

const amountOf = (cents: bigint): string => {
  const whole = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(2, '0');
  return `${whole.toString()}.${fraction}`;
};

describe('failover of an api replica and a consumer under load', () => {
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
  let wallets: TestWallet[] = [];

  beforeAll(async () => {
    await database.connect();
    [operatorToken, providerToken] = await Promise.all([
      clientToken('backoffice'),
      clientToken('provider-a'),
    ]);
    wallets = await Promise.all(
      Array.from({ length: WALLET_COUNT }, () => createWallet(operatorToken)),
    );
  });

  afterAll(async () => {
    sqs.destroy();
    await database.end();
  });

  it(
    'keeps exactly one outcome per operation while an api replica and a consumer die and come back',
    async () => {
      const queueUrl = await queueUrlOf(sqs, WAGER_QUEUE_NAME);
      const dlqUrl = await queueUrlOf(sqs, WAGER_DLQ_NAME);
      const apiContainer = await containerId('api', KILLED_INDEX);
      const consumerContainer = await containerId('consumer', KILLED_INDEX);
      const state: LoadState = {
        httpRunning: true,
        queueRunning: true,
        operations: [],
        httpOutcomes: [],
        envelopes: [],
      };
      const httpLoad = async (): Promise<void> => {
        await Promise.all(
          wallets.flatMap((wallet) =>
            Array.from({ length: HTTP_WORKERS_PER_WALLET }, (_, worker) =>
              httpWorker(providerToken, wallet, worker, state),
            ),
          ),
        );
      };
      const startedAt = performance.now();

      const queueLoad = queuePublisher(sqs, queueUrl, wallets, state);
      const beforeRestart = httpLoad();
      await Bun.sleep(WARMUP_MS);
      await run(['docker', 'kill', apiContainer, consumerContainer]);
      await Bun.sleep(OUTAGE_MS);
      state.httpRunning = false;
      await beforeRestart;

      await run(['docker', 'compose', 'start', 'api', 'consumer']);
      await waitFor(
        async () =>
          (await replicaReady('api', KILLED_INDEX)) &&
          (await replicaReady('consumer', KILLED_INDEX)),
        READY_WAIT,
      );
      await run(['docker', 'compose', 'restart', 'nginx']);
      await waitFor(nginxReady, READY_WAIT);

      state.httpRunning = true;
      const afterRestart = httpLoad();
      await Bun.sleep(COOLDOWN_MS);
      state.httpRunning = false;
      state.queueRunning = false;
      await Promise.all([afterRestart, queueLoad]);
      const loadMs = performance.now() - startedAt;

      const unexpected = state.httpOutcomes.filter(
        (outcome) => !FINAL_STATUSES.includes(outcome.httpStatus),
      );
      expect(unexpected).toEqual([]);

      const messageIds = state.envelopes.map((envelope) => envelope.messageId);
      await waitFor(async () => {
        const result = await database.query(PROCESSED_MESSAGES_SQL, [WAGER_CONSUMER, messageIds]);
        return countSchema.parse(result.rows[0]).count === messageIds.length;
      }, DRAIN_WAIT);
      await waitFor(async () => {
        const [queue, dlq] = await Promise.all([
          countMessages(sqs, queueUrl),
          countMessages(sqs, dlqUrl),
        ]);
        return queue.total === 0 && dlq.total === 0;
      }, DRAIN_WAIT);

      const externalIds = state.operations.map((operation) => operation.externalId);
      expect(new Set(externalIds).size).toBe(externalIds.length);
      await waitFor(async () => {
        const result = await database.query(PENDING_SQL, [PROVIDER_ID, externalIds]);
        return countSchema.parse(result.rows[0]).count === 0;
      }, DRAIN_WAIT);
      const storedResult = await database.query(STORED_SQL, [PROVIDER_ID, externalIds]);
      const stored = storedResult.rows.map((row) => storedTransactionSchema.parse(row));
      expect(stored).toHaveLength(state.operations.length);
      const storedByExternalId = new Map(stored.map((row) => [row.externalId, row]));

      for (const outcome of state.httpOutcomes) {
        const row = storedByExternalId.get(outcome.externalId);
        expect({ externalId: outcome.externalId, id: row?.id, status: row?.status }).toEqual({
          externalId: outcome.externalId,
          id: outcome.transactionId,
          status: outcome.status,
        });
      }
      for (const operation of state.operations) {
        const row = storedByExternalId.get(operation.externalId);
        expect({ externalId: operation.externalId, status: row?.status }).toEqual({
          externalId: operation.externalId,
          status: 'PROCESSED',
        });
        const legs = expectedLegs(row?.kind ?? '', row?.status ?? '');
        expect({
          externalId: operation.externalId,
          walletLegs: row?.walletLegs,
          houseLegs: row?.houseLegs,
        }).toEqual({
          externalId: operation.externalId,
          walletLegs: legs.wallet,
          houseLegs: legs.house,
        });
      }

      const entriesResult = await database.query(WALLET_ENTRIES_SQL, [
        wallets.map((wallet) => wallet.id),
      ]);
      const entriesByWallet = new Map(
        entriesResult.rows
          .map((row) => walletEntriesSchema.parse(row))
          .map((row) => [row.walletId, row.entries]),
      );
      for (const wallet of wallets) {
        const rows = stored.filter((row) => row.walletId === wallet.id);
        const postings = rows.filter((row) => expectedLegs(row.kind, row.status).wallet === 1);
        const expectedCents = postings.reduce(
          (balance, row) =>
            row.kind === 'BET' ? balance - centsOf(row.amount) : balance + centsOf(row.amount),
          centsOf(INITIAL_BALANCE),
        );
        expect(entriesByWallet.get(wallet.id)).toBe(postings.length + 1);

        const view = await fetch(`${API_URL}/wallets/${wallet.id}`, {
          headers: headersFor(operatorToken),
        });
        expect(view.status).toBe(200);
        expect(walletViewSchema.parse(await view.json()).balance.amount).toBe(
          amountOf(expectedCents),
        );

        const reconciliation = await fetch(`${API_URL}/wallets/${wallet.id}/reconciliation`, {
          method: 'POST',
          headers: headersFor(operatorToken),
        });
        expect(reconciliation.status).toBe(200);
        expect(reconciliationSchema.parse(await reconciliation.json())).toMatchObject({
          consistent: true,
          chain: { valid: true },
        });
      }

      const ready = await Promise.all(
        allReplicas().map(async (replica) => ({
          ...replica,
          ready: await replicaReady(replica.service, replica.index),
        })),
      );
      expect(ready.filter((replica) => !replica.ready)).toEqual([]);

      const retried = state.httpOutcomes.filter((outcome) => outcome.retried.length > 0);
      const retriesByStatus = state.httpOutcomes
        .flatMap((outcome) => outcome.retried)
        .reduce<Record<string, number>>((counts, status) => {
          counts[String(status)] = (counts[String(status)] ?? 0) + 1;
          return counts;
        }, {});
      process.stdout.write(
        `${JSON.stringify({
          loadMs: Math.round(loadMs),
          operations: state.operations.length,
          httpOperations: state.httpOutcomes.length,
          queueMessages: state.envelopes.length,
          retriedOperations: retried.length,
          retriesByStatus,
          maxAttempts: Math.max(...state.httpOutcomes.map((outcome) => outcome.attempts)),
        })}\n`,
      );
    },
    { timeout: 420_000 },
  );
});
