import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import type { DestinationStream } from 'pino';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import {
  FIXTURE_INITIAL_BALANCE,
  betCommand,
  createWalletViaUseCase,
  lossCommand,
  refundCommand,
  rollbackCommand,
  toMessageData,
  wagerCommand,
  walletRequest,
  winCommand,
} from '@test/support/fixtures';
import { buildEnvelope, countMessages, publishBody, publishEnvelope } from '@test/support/sqs';
import { TestAppError, createTestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

const WAIT = { timeoutMs: 20_000, intervalMs: 100 } as const;
const AUDIT_CONSUMER = 'wallet-events-audit';

const queryRows = async (
  databaseUrl: string,
  sql: string,
  params: readonly unknown[],
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

const captureLogs = (): { destination: DestinationStream; messages: () => unknown[] } => {
  const lines: string[] = [];
  return {
    destination: {
      write(chunk: string): void {
        lines.push(chunk);
      },
    },
    messages: () =>
      lines.map((line): unknown => {
        const parsed: unknown = JSON.parse(line);
        const message: unknown =
          typeof parsed === 'object' && parsed !== null
            ? Reflect.get(parsed, 'message')
            : undefined;
        return message;
      }),
  };
};

describe('app helpers', () => {
  it('serves the api in process on a random port with the test config and issuer', async () => {
    const database = await createTestDatabase();
    const app = await createTestApp({ roles: ['api'], env: { DATABASE_URL: database.appUrl } });
    try {
      expect(new URL(app.baseUrl).port).not.toBe(String(app.config.HTTP_PORT));
      expect(app.config).toMatchObject({
        OUTBOX_LEASE_MS: 2000,
        PENDING_LEASE_MS: 2000,
        CONSUMER_VISIBILITY_TIMEOUT_SECONDS: 5,
        CONSUMER_VISIBILITY_HEARTBEAT_MS: 1500,
        CONSUMER_MAX_RECEIVE_COUNT: 3,
        PENDING_MAX_DETERMINISTIC_ERRORS: 2,
        ENABLE_FAULT_INJECTION: false,
        AUTH_ISSUER_URL: app.issuer.issuer,
        AUTH_JWKS_URL: app.issuer.jwksUrl,
      });
      expect(app.config.WAGER_QUEUE_NAME).toStartWith('wager-transactions-');

      const ready = await fetch(`${app.baseUrl}/health/ready`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({
        status: 'ok',
        checks: { database: 'up', queue: 'up' },
      });

      const wallet = await createWalletViaUseCase(app);
      expect(wallet.balance).toEqual(FIXTURE_INITIAL_BALANCE);
      expect(wallet.version).toBe(1);
    } finally {
      await app.stop();
    }
  });

  it('runs the consumer in process and hands its log lines to the destination', async () => {
    const database = await createTestDatabase();
    const queues = await createTestQueues();
    const logs = captureLogs();
    const app = await createTestApp({
      roles: ['consumer'],
      env: { DATABASE_URL: database.appUrl, ...queues.env },
      logDestination: logs.destination,
    });
    try {
      expect(app.queueUrls).toEqual(queues.urls);
      const wallet = await createWalletViaUseCase(app);
      const bet = betCommand({ wallet, amount: '25.00' });
      await publishEnvelope(
        app.sqs,
        queues.urls.wagerTransactions,
        buildEnvelope({ data: toMessageData(bet) }),
      );
      await waitFor(async () => {
        const rows = await queryRows(
          database.superuserUrl,
          `select status, balance_snapshot_amount from wager_transactions
            where provider_id = $1 and external_transaction_id = $2`,
          [TEST_PROVIDER_ID, bet.body.externalTransactionId],
        );
        return rows[0]?.status === 'PROCESSED' && rows[0].balance_snapshot_amount === '975.00';
      }, WAIT);

      await publishBody(app.sqs, queues.urls.wagerTransactions, 'not-json', {
        groupId: wallet.id,
        deduplicationId: crypto.randomUUID(),
      });
      await waitFor(
        async () =>
          (await countMessages(app.sqs, queues.urls.wagerTransactionsDlq)).total === 1 &&
          logs.messages().includes('message moved to dlq'),
        WAIT,
      );
      expect(logs.messages()).toContain('message envelope is invalid');
    } finally {
      await app.stop();
    }
  });

  it('starts every role together and delivers outbox events to the audit consumer', async () => {
    const database = await createTestDatabase();
    const app = await createTestApp({
      roles: ['api', 'consumer', 'outbox', 'scheduler', 'events-audit'],
      env: { DATABASE_URL: database.appUrl },
    });
    try {
      const ready = await fetch(`${app.baseUrl}/health/ready`);
      expect(ready.status).toBe(200);
      await createWalletViaUseCase(app, walletRequest({ initialBalance: FIXTURE_INITIAL_BALANCE }));
      await waitFor(async () => {
        const rows = await queryRows(
          database.superuserUrl,
          'select count(*)::int as audited from inbox_messages where consumer_name = $1',
          [AUDIT_CONSUMER],
        );
        return rows[0]?.audited === 2;
      }, WAIT);
    } finally {
      await app.stop();
    }
  });

  it('refuses fault injection before opening any resource', async () => {
    const failure = await createTestApp({
      roles: ['api'],
      env: {
        DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none',
        ENABLE_FAULT_INJECTION: 'true',
        FAULT_POINTS: 'api.before_commit',
      },
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(failure).toBeInstanceOf(TestAppError);
  });

  it('builds a request of every kind for the same wallet', () => {
    const wallet = { id: crypto.randomUUID(), playerId: crypto.randomUUID() };
    const bet = betCommand({ wallet });
    const reference = { wallet, referenceExternalTransactionId: bet.body.externalTransactionId };
    const kinds = [
      bet,
      winCommand(reference),
      lossCommand(reference),
      refundCommand(reference),
      rollbackCommand(reference),
    ].map((request) => request.body.kind);
    expect(kinds).toEqual([
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Loss,
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ]);
    expect(bet.body).toMatchObject({
      providerId: TEST_PROVIDER_ID,
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: { amount: '10.00', currency: 'BRL' },
    });
    expect(bet.body).not.toHaveProperty('referenceExternalTransactionId');
    expect(toMessageData(wagerCommand(WagerTransactionKind.Win, reference))).toMatchObject({
      kind: WagerTransactionKind.Win,
      referenceExternalTransactionId: bet.body.externalTransactionId,
    });
  });
});
