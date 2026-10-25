import { beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { waitFor } from '@test/support/wait-for';

type KeycloakClient = 'provider-a' | 'backoffice';

const TOKEN_URL = 'http://localhost:8081/realms/jungle/protocol/openid-connect/token';
const API_URL = 'http://localhost:8080';
const PROVIDER_ID = 'provider-a';
const CURRENCY = 'BRL';
const API_REPLICAS = 3;
const WALLET_COUNT = 3;
const REQUEST_COUNT = 300;
const CONCURRENCY = 30;
const BET_AMOUNT = '0.10';
const LOG_WAIT = { timeoutMs: 30_000, intervalMs: 500 } as const;

const tokenResponseSchema = z.object({ access_token: z.string().min(1) });
const createdWalletSchema = z.object({ id: z.string(), playerId: z.string() });
const transactionResultSchema = z.object({ status: z.string() }).passthrough();
const walletViewSchema = z
  .object({ balance: z.object({ amount: z.string(), currency: z.string() }) })
  .passthrough();
const reconciliationSchema = z.object({ consistent: z.boolean() }).passthrough();
const requestLogSchema = z.object({
  instanceId: z.string(),
  correlationId: z.string(),
  message: z.literal('request completed'),
});

interface TestWallet {
  readonly id: string;
  readonly playerId: string;
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
      initialBalance: { amount: '100.00', currency: CURRENCY },
    }),
  });
  expect(response.status).toBe(201);
  return createdWalletSchema.parse(await response.json());
};

const submitBet = (
  providerToken: string,
  wallet: TestWallet,
  correlationId: string,
): Promise<Response> => {
  const id = randomUUID();
  return fetch(`${API_URL}/wagering/transactions`, {
    method: 'POST',
    headers: headersFor(providerToken, {
      'Idempotency-Key': `idem-${id}`,
      'X-Correlation-Id': correlationId,
    }),
    body: JSON.stringify({
      providerId: PROVIDER_ID,
      externalTransactionId: `ext-${id}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${id}`,
      gameId: 'replica-game',
      kind: 'BET',
      money: { amount: BET_AMOUNT, currency: CURRENCY },
    }),
  });
};

const parseLine = (line: string): z.infer<typeof requestLogSchema> | undefined => {
  try {
    const parsed = requestLogSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

const instancesByCorrelation = async (prefix: string): Promise<Map<string, string>> => {
  const child = Bun.spawn(['docker', 'compose', 'logs', '--no-log-prefix', 'api'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(exitCode).toBe(0);
  const instances = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const entry = parseLine(line);
    if (entry?.correlationId.startsWith(prefix) === true) {
      instances.set(entry.correlationId, entry.instanceId);
    }
  }
  return instances;
};

describe('api replicas behind nginx', () => {
  const runId = randomUUID();
  let operatorToken = '';
  let providerToken = '';
  let wallets: TestWallet[] = [];

  beforeAll(async () => {
    [operatorToken, providerToken] = await Promise.all([
      clientToken('backoffice'),
      clientToken('provider-a'),
    ]);
    wallets = await Promise.all(
      Array.from({ length: WALLET_COUNT }, () => createWallet(operatorToken)),
    );
  });

  it(
    'spreads 300 requests over the three api replicas with a consistent result',
    async () => {
      const correlationIds = Array.from(
        { length: REQUEST_COUNT },
        (_, index) => `replicas-${runId}-${String(index)}`,
      );

      const statuses: string[] = [];
      for (let start = 0; start < REQUEST_COUNT; start += CONCURRENCY) {
        const batch = correlationIds.slice(start, start + CONCURRENCY);
        const results = await Promise.all(
          batch.map(async (correlationId, offset) => {
            const wallet = wallets[(start + offset) % WALLET_COUNT];
            if (wallet === undefined) {
              return 'missing-wallet';
            }
            const response = await submitBet(providerToken, wallet, correlationId);
            expect(response.status).toBe(200);
            return transactionResultSchema.parse(await response.json()).status;
          }),
        );
        statuses.push(...results);
      }
      expect(statuses.filter((status) => status === 'PROCESSED')).toHaveLength(REQUEST_COUNT);

      let instances = new Map<string, string>();
      await waitFor(async () => {
        instances = await instancesByCorrelation(`replicas-${runId}-`);
        return instances.size === REQUEST_COUNT;
      }, LOG_WAIT);
      expect(new Set(instances.values()).size).toBe(API_REPLICAS);

      for (const wallet of wallets) {
        const view = await fetch(`${API_URL}/wallets/${wallet.id}`, {
          headers: headersFor(operatorToken),
        });
        expect(view.status).toBe(200);
        expect(walletViewSchema.parse(await view.json()).balance).toEqual({
          amount: '90.00',
          currency: CURRENCY,
        });

        const reconciliation = await fetch(`${API_URL}/wallets/${wallet.id}/reconciliation`, {
          method: 'POST',
          headers: headersFor(operatorToken),
        });
        expect(reconciliation.status).toBe(200);
        expect(reconciliationSchema.parse(await reconciliation.json()).consistent).toBe(true);
      }
    },
    { timeout: 120_000 },
  );
});
