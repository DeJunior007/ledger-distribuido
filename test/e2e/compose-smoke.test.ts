import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { decodeJwt } from 'jose';
import { Client } from 'pg';
import { z } from 'zod';
import { createSqsClient } from '@infrastructure/messaging/sqs.client';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import type { RequestWagerKind } from '@interfaces/http/schemas/wager-transaction.schema';
import { buildEnvelope, publishEnvelope } from '@test/support/sqs';
import { waitFor } from '@test/support/wait-for';

type KeycloakClient = 'provider-a' | 'backoffice';

const EXPECTED_ISSUER = 'http://localhost:8081/realms/jungle';
const TOKEN_URL = `${EXPECTED_ISSUER}/protocol/openid-connect/token`;
const API_URL = 'http://localhost:8080';
const SQS_ENDPOINT = 'http://localhost:4566';
const DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/jungle';
const WAGER_QUEUE_NAME = 'wager-transactions.fifo';
const WAGER_CONSUMER = 'wager-transactions-consumer';
const AUDIT_CONSUMER = 'wallet-events-audit';
const PROVIDER_ID = 'provider-a';
const CURRENCY = 'BRL';
const SQS_TIMEOUT_MS = 5000;
const QUEUE_WAIT = { timeoutMs: 60_000, intervalMs: 250 } as const;
const SERVICE_REPLICAS = {
  api: 3,
  consumer: 3,
  outbox: 2,
  scheduler: 2,
  'events-audit': 1,
} as const;

const tokenResponseSchema = z.object({ access_token: z.string().min(1) });
const moneySchema = z.object({ amount: z.string(), currency: z.string() });
const createdWalletSchema = z.object({ id: z.string(), playerId: z.string() });
const transactionResultSchema = z
  .object({
    transactionId: z.string().nullable(),
    status: z.string(),
    kind: z.string(),
    balance: moneySchema.nullable(),
    idempotentReplay: z.boolean(),
  })
  .passthrough();
const problemSchema = z.object({ failureCode: z.string() }).passthrough();
const reconciliationSchema = z
  .object({
    walletId: z.string(),
    storedBalance: moneySchema,
    calculatedBalance: moneySchema,
    consistent: z.boolean(),
    checkedEntries: z.number(),
    chain: z.object({ valid: z.boolean() }).passthrough(),
  })
  .passthrough();
const readinessSchema = z.object({ status: z.string() }).passthrough();
const countRowSchema = z.object({ count: z.number() });
const queueTransactionSchema = z.object({ status: z.string(), amount: z.string() });

interface WagerRequest {
  readonly idempotencyKey: string;
  readonly body: Record<string, unknown>;
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

const authorized = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

const postJson = (path: string, token: string, body: unknown, headers = {}): Promise<Response> =>
  fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { ...authorized(token), ...headers },
    body: JSON.stringify(body),
  });

const wagerRequest = (
  kind: RequestWagerKind,
  wallet: { readonly id: string; readonly playerId: string },
  roundId: string,
  amount: string,
): WagerRequest => {
  const id = randomUUID();
  return {
    idempotencyKey: `idem-${id}`,
    body: {
      providerId: PROVIDER_ID,
      externalTransactionId: `ext-${id}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId,
      gameId: 'smoke-game',
      kind,
      money: { amount, currency: CURRENCY },
    },
  };
};

const submit = (token: string, request: WagerRequest): Promise<Response> =>
  postJson('/wagering/transactions', token, request.body, {
    'Idempotency-Key': request.idempotencyKey,
  });

const readinessScript = [
  `const response = await fetch('http://localhost:3000/health/ready');`,
  `process.stdout.write(JSON.stringify({ code: response.status, body: await response.json() }));`,
].join('\n');

const serviceReadiness = async (service: string, index: number): Promise<unknown> => {
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
  expect(exitCode).toBe(0);
  return JSON.parse(stdout);
};

const countRows = async (database: Client, sql: string, values: unknown[]): Promise<number> => {
  const result = await database.query(sql, values);
  return countRowSchema.parse(result.rows[0]).count;
};

describe('compose smoke through nginx', () => {
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
  let wallet = { id: '', playerId: '' };
  let queuedExternalId = '';

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

  it('obtains operator and provider tokens from the real keycloak', () => {
    const operator = decodeJwt(operatorToken);
    const provider = decodeJwt(providerToken);

    expect(operator.iss).toBe(EXPECTED_ISSUER);
    expect(provider.iss).toBe(EXPECTED_ISSUER);
    expect(operator.azp).toBe('backoffice');
    expect(provider.provider_id).toBe(PROVIDER_ID);
  });

  it('creates a wallet, bets, wins, replays, conflicts and reconciles through nginx', async () => {
    const created = await postJson('/wallets', operatorToken, {
      playerId: randomUUID(),
      initialBalance: { amount: '100.00', currency: CURRENCY },
    });
    expect(created.status).toBe(201);
    wallet = createdWalletSchema.parse(await created.json());

    const roundId = `round-${randomUUID()}`;
    const bet = wagerRequest(WagerTransactionKind.Bet, wallet, roundId, '30.00');
    const betResponse = await submit(providerToken, bet);
    expect(betResponse.status).toBe(200);
    const betResult = transactionResultSchema.parse(await betResponse.json());
    expect(betResult).toMatchObject({
      status: 'PROCESSED',
      kind: 'BET',
      balance: { amount: '70.00', currency: CURRENCY },
      idempotentReplay: false,
    });

    const win = wagerRequest(WagerTransactionKind.Win, wallet, roundId, '50.00');
    const winResponse = await submit(providerToken, win);
    expect(winResponse.status).toBe(200);
    expect(transactionResultSchema.parse(await winResponse.json())).toMatchObject({
      status: 'PROCESSED',
      kind: 'WIN',
      balance: { amount: '120.00', currency: CURRENCY },
    });

    const replayResponse = await submit(providerToken, bet);
    expect(replayResponse.status).toBe(200);
    const replay = transactionResultSchema.parse(await replayResponse.json());
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(betResult.transactionId);
    expect(replay.status).toBe(betResult.status);
    expect(replay.balance).toEqual(betResult.balance);

    const conflicting = {
      idempotencyKey: bet.idempotencyKey,
      body: { ...bet.body, money: { amount: '31.00', currency: CURRENCY } },
    };
    const conflictResponse = await submit(providerToken, conflicting);
    expect(conflictResponse.status).toBe(409);
    expect(problemSchema.parse(await conflictResponse.json()).failureCode).toBe(
      'IDEMPOTENCY_KEY_CONFLICT',
    );

    const reconciliationResponse = await postJson(
      `/wallets/${wallet.id}/reconciliation`,
      operatorToken,
      {},
    );
    expect(reconciliationResponse.status).toBe(200);
    const report = reconciliationSchema.parse(await reconciliationResponse.json());
    expect(report).toMatchObject({
      walletId: wallet.id,
      storedBalance: { amount: '120.00', currency: CURRENCY },
      calculatedBalance: { amount: '120.00', currency: CURRENCY },
      consistent: true,
      chain: { valid: true },
    });
  });

  it('processes a bet published to the queue with one of the consumers', async () => {
    const queue = await sqs.send(new GetQueueUrlCommand({ QueueName: WAGER_QUEUE_NAME }));
    const queueUrl = queue.QueueUrl ?? '';
    expect(queueUrl).not.toBe('');
    const envelope = buildEnvelope({
      data: {
        providerId: PROVIDER_ID,
        walletId: wallet.id,
        playerId: wallet.playerId,
        money: { amount: '20.00', currency: CURRENCY },
      },
    });
    queuedExternalId = envelope.data.externalTransactionId;
    await publishEnvelope(sqs, queueUrl, envelope);

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

    const stored = await database.query(
      `SELECT status, amount::text AS amount FROM wager_transactions
       WHERE provider_id = $1 AND external_transaction_id = $2`,
      [PROVIDER_ID, envelope.data.externalTransactionId],
    );
    expect(stored.rows.map((row) => queueTransactionSchema.parse(row))).toEqual([
      { status: 'PROCESSED', amount: '20.00' },
    ]);
    const walletRow = await database.query(
      'SELECT balance::text AS balance FROM wallets WHERE id = $1',
      [wallet.id],
    );
    expect(walletRow.rows).toEqual([{ balance: '100.00' }]);
  });

  it('records every wallet event in the events-audit', async () => {
    const outboxSql = `SELECT count(*)::int AS count FROM outbox_messages WHERE aggregate_id = $1`;
    const auditedSql = `SELECT count(*)::int AS count FROM outbox_messages o
      JOIN inbox_messages i ON i.consumer_name = $2 AND i.message_id = o.id::text
      WHERE o.aggregate_id = $1 AND o.published_at IS NOT NULL AND i.processed_at IS NOT NULL`;
    const processedSql = `SELECT count(*)::int AS count FROM outbox_messages o
      JOIN inbox_messages i ON i.consumer_name = $2 AND i.message_id = o.id::text
      WHERE o.aggregate_id = $1 AND o.event_type = 'WagerTransactionProcessed'
        AND o.payload -> 'data' ->> 'externalTransactionId' = $3`;

    const events = await countRows(database, outboxSql, [wallet.id]);
    expect(events).toBeGreaterThan(0);
    await waitFor(
      async () => (await countRows(database, auditedSql, [wallet.id, AUDIT_CONSUMER])) === events,
      QUEUE_WAIT,
    );

    expect(
      await countRows(database, processedSql, [wallet.id, AUDIT_CONSUMER, queuedExternalId]),
    ).toBe(1);
  });

  it('reports every service ready', async () => {
    const throughNginx = await fetch(`${API_URL}/health/ready`);
    expect(throughNginx.status).toBe(200);
    expect(readinessSchema.parse(await throughNginx.json()).status).toBe('ok');

    const targets = Object.entries(SERVICE_REPLICAS).flatMap(([service, replicas]) =>
      Array.from({ length: replicas }, (_, offset) => ({ service, index: offset + 1 })),
    );
    const reports = await Promise.all(
      targets.map(async (target) => ({
        ...target,
        report: await serviceReadiness(target.service, target.index),
      })),
    );

    for (const { service, index, report } of reports) {
      expect({ service, index, report }).toMatchObject({
        service,
        index,
        report: { code: 200, body: { status: 'ok' } },
      });
    }
  });
});
