import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import type {
  RequestWagerKind,
  WagerTransactionRequest,
} from '@interfaces/http/schemas/wager-transaction.schema';
import {
  createWalletViaApi,
  submitViaApi,
  toMessageData,
  wagerCommand,
} from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import { spawnInstances } from '@test/support/spawn-instances';
import type { SpawnedInstances } from '@test/support/spawn-instances';
import {
  buildEnvelope,
  countMessages,
  createTestSqsClient,
  publishEnvelope,
} from '@test/support/sqs';
import { createTestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID, TestIssuer } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';
import type { TestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

const WALLET_COUNT = 4;
const ROUNDS = 6;
const OVERDRAFT_AMOUNT = '99999.00';
const TRANSIENT_STATUS = 503;
const MAX_ATTEMPTS = 10;
const RETRY_BACKOFF_MS = 200;
const SETTLE_WAIT = { timeoutMs: 120_000, intervalMs: 500 } as const;
const FOLLOW_UP_KINDS: readonly RequestWagerKind[] = [
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

interface Topology {
  readonly apis: number;
  readonly consumers: number;
}

interface Deployment {
  readonly databaseUrl: string;
  readonly queues: TestQueues;
  readonly issuer: TestIssuer;
  readonly sqs: SQSClient;
  readonly groups: SpawnedInstances[];
}

interface Phases {
  readonly bets: readonly WagerTransactionRequest[];
  readonly followUps: readonly WagerTransactionRequest[];
}

interface Outcome {
  readonly outcomes: Record<string, unknown>[];
  readonly wallets: Record<string, unknown>[];
}

const queryRows = async (
  databaseUrl: string,
  sql: string,
  params: readonly unknown[] = [],
): Promise<Record<string, unknown>[]> => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<Record<string, unknown>>(sql, [...params]);
    return result.rows;
  } finally {
    await client.end();
  }
};

const betAmount = (slot: number, round: number): string =>
  `${String(round + 1)}.${String(slot).padStart(2, '0')}`;

const followUpAmount = (kind: RequestWagerKind, slot: number, round: number): string =>
  kind === WagerTransactionKind.Win
    ? `${String(round * 2 + 3)}.${String(slot).padStart(2, '0')}`
    : betAmount(slot, round);

const command = (
  wallet: TestWallet,
  kind: RequestWagerKind,
  key: string,
  roundKey: string,
  amount: string,
  reference?: string,
): WagerTransactionRequest =>
  wagerCommand(kind, {
    wallet,
    amount,
    externalTransactionId: key,
    idempotencyKey: `idem-${key}`,
    roundId: roundKey,
    ...(reference === undefined ? {} : { referenceExternalTransactionId: reference }),
  });

const phasesFor = (wallets: readonly TestWallet[]): Phases => {
  const rounds = wallets.flatMap((wallet, slot) =>
    Array.from({ length: ROUNDS }, (_, round) => {
      const roundKey = `round-${String(slot)}-${String(round)}`;
      const betKey = `${roundKey}-bet`;
      const kind = FOLLOW_UP_KINDS[round % FOLLOW_UP_KINDS.length] ?? WagerTransactionKind.Win;
      return {
        bet: command(wallet, WagerTransactionKind.Bet, betKey, roundKey, betAmount(slot, round)),
        followUp: command(
          wallet,
          kind,
          `${roundKey}-${kind.toLowerCase()}`,
          roundKey,
          followUpAmount(kind, slot, round),
          betKey,
        ),
      };
    }),
  );
  const overdrafts = wallets.map((wallet, slot) =>
    command(
      wallet,
      WagerTransactionKind.Bet,
      `overdraft-${String(slot)}`,
      `round-overdraft-${String(slot)}`,
      OVERDRAFT_AMOUNT,
    ),
  );
  return {
    bets: [...rounds.map((round) => round.bet), ...overdrafts],
    followUps: rounds.map((round) => round.followUp),
  };
};

const submitWithRetry = async (
  baseUrl: string,
  providerToken: string,
  request: WagerTransactionRequest,
): Promise<number> => {
  for (let attempt = 1; ; attempt += 1) {
    const response = await submitViaApi(baseUrl, providerToken, request);
    await response.arrayBuffer();
    if (response.status !== TRANSIENT_STATUS || attempt >= MAX_ATTEMPTS) {
      return response.status;
    }
    await Bun.sleep(RETRY_BACKOFF_MS * attempt);
  }
};

const deploy = async (topology: Topology): Promise<Deployment> => {
  const database = await createTestDatabase();
  const queues = await createTestQueues();
  const issuer = await TestIssuer.start();
  const env = { DATABASE_URL: database.appUrl, ...queues.env, ...issuer.authConfig };
  const spawned = await Promise.allSettled([
    spawnInstances({ role: 'api', count: topology.apis, env }),
    spawnInstances({ role: 'consumer', count: topology.consumers, env }),
  ]);
  const deployment: Deployment = {
    databaseUrl: database.appUrl,
    queues,
    issuer,
    sqs: createTestSqsClient(),
    groups: spawned.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])),
  };
  return deployment;
};

const teardown = async (deployment: Deployment): Promise<void> => {
  deployment.sqs.destroy();
  await Promise.all(deployment.groups.map((group) => group.stop()));
  await deployment.issuer.stop();
};

const apisOf = (deployment: Deployment): SpawnedInstances => {
  const [apis] = deployment.groups;
  if (apis === undefined) {
    throw new RangeError('api instances did not start');
  }
  return apis;
};

const totalRows = async (
  deployment: Deployment,
  walletIds: readonly string[],
): Promise<unknown> => {
  const rows = await queryRows(
    deployment.databaseUrl,
    `SELECT
       (SELECT count(*)::int FROM wager_transactions
         WHERE wallet_id = ANY($1::uuid[]) AND kind <> 'OPENING') AS total,
       (SELECT count(*)::int FROM wager_transactions
         WHERE wallet_id = ANY($1::uuid[]) AND status = 'PENDING_REFERENCE') AS pending`,
    [walletIds],
  );
  return rows[0];
};

const sendPhase = async (
  deployment: Deployment,
  providerToken: string,
  requests: readonly WagerTransactionRequest[],
): Promise<number[]> => {
  const apis = apisOf(deployment);
  const statuses = await Promise.all(
    requests.map(async (request, index) => {
      if (index % 2 === 0) {
        const api = apis.instance((index / 2) % apis.instances.length);
        return submitWithRetry(api.baseUrl, providerToken, request);
      }
      await publishEnvelope(
        deployment.sqs,
        deployment.queues.urls.wagerTransactions,
        buildEnvelope({ data: toMessageData(request) }),
        { groupId: randomUUID() },
      );
      return 0;
    }),
  );
  return statuses;
};

const settle = async (
  deployment: Deployment,
  walletIds: readonly string[],
  expectedTotal: number,
): Promise<void> => {
  await waitFor(async () => {
    const counts = await countMessages(deployment.sqs, deployment.queues.urls.wagerTransactions);
    const rows = await totalRows(deployment, walletIds);
    return (
      counts.total === 0 &&
      JSON.stringify(rows) === JSON.stringify({ total: expectedTotal, pending: 0 })
    );
  }, SETTLE_WAIT);
};

const outcomeOf = async (
  deployment: Deployment,
  wallets: readonly TestWallet[],
): Promise<Outcome> => {
  const walletIds = wallets.map((wallet) => wallet.id);
  const outcomes = await queryRows(
    deployment.databaseUrl,
    `SELECT t.external_transaction_id AS "externalId", t.kind, t.status,
            t.failure_code AS "failureCode", t.amount::text AS amount
       FROM wager_transactions t
      WHERE t.wallet_id = ANY($1::uuid[]) AND t.kind <> 'OPENING'
      ORDER BY t.external_transaction_id`,
    [walletIds],
  );
  const rows = await queryRows(
    deployment.databaseUrl,
    `SELECT w.id, w.balance::text AS balance, w.version,
            (SELECT count(*)::int FROM wallet_ledger_entries e WHERE e.wallet_id = w.id) AS entries,
            (SELECT coalesce(sum(e.amount), 0)::text FROM wallet_ledger_entries e
              WHERE e.wallet_id = w.id AND e.direction = 'DEBIT') AS debits,
            (SELECT coalesce(sum(e.amount), 0)::text FROM wallet_ledger_entries e
              WHERE e.wallet_id = w.id AND e.direction = 'CREDIT') AS credits
       FROM wallets w
      WHERE w.id = ANY($1::uuid[])`,
    [walletIds],
  );
  return {
    outcomes,
    wallets: wallets.map((wallet, slot) => {
      const row = rows.find((candidate) => candidate.id === wallet.id) ?? {};
      return {
        slot,
        balance: row.balance,
        version: row.version,
        entries: row.entries,
        debits: row.debits,
        credits: row.credits,
      };
    }),
  };
};

const runWorkload = async (deployment: Deployment): Promise<Outcome> => {
  const apis = apisOf(deployment);
  const operatorToken = await deployment.issuer.token({ role: 'operator' });
  const providerToken = await deployment.issuer.token({
    role: 'provider',
    providerId: TEST_PROVIDER_ID,
  });
  const wallets: TestWallet[] = [];
  for (let slot = 0; slot < WALLET_COUNT; slot += 1) {
    wallets.push(await createWalletViaApi(apis.instance(0).baseUrl, operatorToken));
  }
  const walletIds = wallets.map((wallet) => wallet.id);
  const phases = phasesFor(wallets);

  const betStatuses = await sendPhase(deployment, providerToken, phases.bets);
  expect(betStatuses.filter((status) => status !== 0 && status !== 200 && status !== 422)).toEqual(
    [],
  );
  await settle(deployment, walletIds, phases.bets.length);

  const followUpStatuses = await sendPhase(deployment, providerToken, phases.followUps);
  expect(followUpStatuses.filter((status) => status !== 0 && status !== 200)).toEqual([]);
  await settle(deployment, walletIds, phases.bets.length + phases.followUps.length);

  return outcomeOf(deployment, wallets);
};

describe('§5.8 múltiplas instâncias', () => {
  it('gives 3 apis and 3 consumers the same result as 1 api and 1 consumer', async () => {
    const deployments = await Promise.all([
      deploy({ apis: 1, consumers: 1 }),
      deploy({ apis: 3, consumers: 3 }),
    ]);
    try {
      expect(deployments.map((deployment) => deployment.groups.length)).toEqual([2, 2]);
      const [single, multi] = await Promise.all(deployments.map(runWorkload));

      expect(single?.outcomes).toHaveLength(WALLET_COUNT * (ROUNDS * 2 + 1));
      expect(single?.outcomes.filter((row) => row.status === 'REJECTED')).toHaveLength(
        WALLET_COUNT,
      );
      expect(single?.outcomes.filter((row) => row.status === 'PROCESSED')).toHaveLength(
        WALLET_COUNT * ROUNDS * 2,
      );
      expect(multi?.outcomes).toEqual(single?.outcomes ?? []);
      expect(multi?.wallets).toEqual(single?.wallets ?? []);
    } finally {
      await Promise.all(deployments.map(teardown));
    }
  });
});
