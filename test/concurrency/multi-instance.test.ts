import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import type { RequestWagerKind } from '@interfaces/http/schemas/wager-transaction.schema';
import type { WagerTransactionRequest } from '@interfaces/http/schemas/wager-transaction.schema';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
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
import { waitFor } from '@test/support/wait-for';

const API_COUNT = 3;
const HOT_ROUNDS = 12;
const COLD_ROUNDS = 3;
const COLD_WALLETS = 5;
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

interface PlannedOperation {
  readonly slot: number;
  readonly key: string;
  readonly request: WagerTransactionRequest;
  readonly isBet: boolean;
}

interface OperationSet {
  readonly tag: string;
  readonly wallets: readonly TestWallet[];
  readonly operations: readonly PlannedOperation[];
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

const roundsOf = (slot: number): number => (slot === 0 ? HOT_ROUNDS : COLD_ROUNDS);

const betAmount = (slot: number, round: number): string =>
  `${String(round + 1)}.${String(slot).padStart(2, '0')}`;

const followUpAmount = (kind: RequestWagerKind, slot: number, round: number): string =>
  kind === WagerTransactionKind.Win
    ? `${String(round * 2 + 3)}.${String(slot).padStart(2, '0')}`
    : betAmount(slot, round);

const walletOperations = (tag: string, wallet: TestWallet, slot: number): PlannedOperation[] => {
  const command = (
    kind: RequestWagerKind,
    key: string,
    roundKey: string,
    amount: string,
    reference: string | undefined,
  ): WagerTransactionRequest =>
    wagerCommand(kind, {
      wallet,
      amount,
      externalTransactionId: `${tag}-${key}`,
      idempotencyKey: `${tag}-idem-${key}`,
      roundId: `${tag}-${roundKey}`,
      ...(reference === undefined ? {} : { referenceExternalTransactionId: `${tag}-${reference}` }),
    });
  const rounds = Array.from({ length: roundsOf(slot) }, (_, round) => {
    const roundKey = `round-${String(slot)}-${String(round)}`;
    const betKey = `${roundKey}-bet`;
    const kind = FOLLOW_UP_KINDS[round % FOLLOW_UP_KINDS.length] ?? WagerTransactionKind.Win;
    const followUpKey = `${roundKey}-${kind.toLowerCase()}`;
    return [
      {
        slot,
        key: betKey,
        isBet: true,
        request: command(
          WagerTransactionKind.Bet,
          betKey,
          roundKey,
          betAmount(slot, round),
          undefined,
        ),
      },
      {
        slot,
        key: followUpKey,
        isBet: false,
        request: command(kind, followUpKey, roundKey, followUpAmount(kind, slot, round), betKey),
      },
    ];
  }).flat();
  const overdraftKey = `overdraft-${String(slot)}`;
  return [
    ...rounds,
    {
      slot,
      key: overdraftKey,
      isBet: true,
      request: command(
        WagerTransactionKind.Bet,
        overdraftKey,
        `round-${overdraftKey}`,
        OVERDRAFT_AMOUNT,
        undefined,
      ),
    },
  ];
};

const createSet = async (
  apis: SpawnedInstances,
  operatorToken: string,
  tag: string,
): Promise<OperationSet> => {
  const wallets = await Promise.all(
    Array.from({ length: COLD_WALLETS + 1 }, (_, slot) =>
      createWalletViaApi(apis.instance(slot % API_COUNT).baseUrl, operatorToken),
    ),
  );
  return {
    tag,
    wallets,
    operations: wallets.flatMap((wallet, slot) => walletOperations(tag, wallet, slot)),
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

const followUpsFirst = (operations: readonly PlannedOperation[]): PlannedOperation[] => [
  ...operations.filter((operation) => !operation.isBet),
  ...operations.filter((operation) => operation.isBet),
];

const outcomesOf = async (
  databaseUrl: string,
  set: OperationSet,
): Promise<Record<string, unknown>[]> => {
  const rows = await queryRows(
    databaseUrl,
    `SELECT t.external_transaction_id AS "externalId", t.kind, t.status,
            t.failure_code AS "failureCode", t.amount::text AS amount
       FROM wager_transactions t
      WHERE t.wallet_id = ANY($1::uuid[]) AND t.kind <> 'OPENING'`,
    [set.wallets.map((wallet) => wallet.id)],
  );
  return rows
    .map((row) => ({ ...row, externalId: String(row.externalId).replace(`${set.tag}-`, '') }))
    .sort((left, right) => left.externalId.localeCompare(right.externalId));
};

const walletsOf = async (
  databaseUrl: string,
  set: OperationSet,
): Promise<Record<string, unknown>[]> => {
  const rows = await queryRows(
    databaseUrl,
    `SELECT w.id, w.balance::text AS balance, w.version,
            (SELECT count(*)::int FROM wallet_ledger_entries e WHERE e.wallet_id = w.id) AS entries,
            (SELECT coalesce(sum(e.amount), 0)::text FROM wallet_ledger_entries e
              WHERE e.wallet_id = w.id AND e.direction = 'DEBIT') AS debits,
            (SELECT coalesce(sum(e.amount), 0)::text FROM wallet_ledger_entries e
              WHERE e.wallet_id = w.id AND e.direction = 'CREDIT') AS credits
       FROM wallets w
      WHERE w.id = ANY($1::uuid[])`,
    [set.wallets.map((wallet) => wallet.id)],
  );
  return set.wallets.map((wallet, slot) => {
    const row = rows.find((candidate) => candidate.id === wallet.id) ?? {};
    return {
      slot,
      balance: row.balance,
      version: row.version,
      entries: row.entries,
      debits: row.debits,
      credits: row.credits,
    };
  });
};

const settled = async (databaseUrl: string, set: OperationSet): Promise<boolean> => {
  const rows = await queryRows(
    databaseUrl,
    `SELECT
       (SELECT count(*)::int FROM wager_transactions
         WHERE wallet_id = ANY($1::uuid[]) AND kind <> 'OPENING') AS total,
       (SELECT count(*)::int FROM wager_transactions
         WHERE wallet_id = ANY($1::uuid[]) AND status = 'PENDING_REFERENCE') AS pending,
       (SELECT count(*)::int FROM outbox_messages WHERE published_at IS NULL) AS unpublished`,
    [set.wallets.map((wallet) => wallet.id)],
  );
  const row = rows[0] ?? {};
  return row.total === set.operations.length && row.pending === 0 && row.unpublished === 0;
};

const stopAll = async (groups: readonly SpawnedInstances[]): Promise<void> => {
  await Promise.all(groups.map((group) => group.stop()));
};

describe('multi-instance', () => {
  it('matches the serial execution with 3 apis, 3 consumers, 2 outbox and 2 schedulers', async () => {
    const database = await createTestDatabase();
    const queues = await createTestQueues();
    const issuer = await TestIssuer.start();
    const sqs = createTestSqsClient();
    const env = { DATABASE_URL: database.appUrl, ...queues.env, ...issuer.authConfig };
    const spawned = await Promise.allSettled([
      spawnInstances({ role: 'api', count: API_COUNT, env }),
      spawnInstances({ role: 'consumer', count: 3, env }),
      spawnInstances({ role: 'outbox', count: 2, env }),
      spawnInstances({ role: 'scheduler', count: 2, env }),
    ]);
    const groups = spawned.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    try {
      expect(spawned.map((result) => result.status)).toEqual([
        'fulfilled',
        'fulfilled',
        'fulfilled',
        'fulfilled',
      ]);
      const [apis] = groups;
      if (apis === undefined) {
        throw new RangeError('api instances did not start');
      }
      const operatorToken = await issuer.token({ role: 'operator' });
      const providerToken = await issuer.token({ role: 'provider', providerId: TEST_PROVIDER_ID });
      const parallel = await createSet(apis, operatorToken, `par-${randomUUID()}`);
      const serial = await createSet(apis, operatorToken, `ser-${randomUUID()}`);

      const serialStatuses: number[] = [];
      for (const operation of serial.operations) {
        serialStatuses.push(
          await submitWithRetry(apis.instance(0).baseUrl, providerToken, operation.request),
        );
      }

      const parallelStatuses = await Promise.all(
        followUpsFirst(parallel.operations).map(async (operation, index) => {
          if (index % 2 === 0) {
            return submitWithRetry(
              apis.instance((index / 2) % API_COUNT).baseUrl,
              providerToken,
              operation.request,
            );
          }
          await publishEnvelope(
            sqs,
            queues.urls.wagerTransactions,
            buildEnvelope({ data: toMessageData(operation.request) }),
            { groupId: randomUUID() },
          );
          return 0;
        }),
      );

      expect(serialStatuses.filter((status) => status !== 200 && status !== 422)).toEqual([]);
      expect(
        parallelStatuses.filter(
          (status) => status !== 0 && status !== 200 && status !== 202 && status !== 422,
        ),
      ).toEqual([]);
      await waitFor(() => settled(database.appUrl, serial), SETTLE_WAIT);
      await waitFor(() => settled(database.appUrl, parallel), SETTLE_WAIT);
      await waitFor(
        async () => (await countMessages(sqs, queues.urls.wagerTransactions)).total === 0,
        SETTLE_WAIT,
      );
      const serialOutcomes = await outcomesOf(database.appUrl, serial);
      expect(serialOutcomes).toHaveLength(serial.operations.length);
      expect(serialOutcomes.filter((row) => row.status === 'REJECTED')).toHaveLength(
        COLD_WALLETS + 1,
      );
      expect(await outcomesOf(database.appUrl, parallel)).toEqual(serialOutcomes);
      expect(await walletsOf(database.appUrl, parallel)).toEqual(
        await walletsOf(database.appUrl, serial),
      );
      expect(
        await queryRows(
          database.appUrl,
          'SELECT count(*)::int AS parked FROM outbox_messages WHERE parked_at IS NOT NULL',
        ),
      ).toEqual([{ parked: 0 }]);
    } finally {
      sqs.destroy();
      await stopAll(groups);
      await issuer.stop();
    }
  });
});
