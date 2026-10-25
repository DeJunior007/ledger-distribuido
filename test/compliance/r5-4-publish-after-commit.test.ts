import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { FAULT_KILL_EXIT_CODE, faultEnv } from '@test/support/fault-env';
import {
  betCommand,
  createWalletViaApi,
  createWalletViaUseCase,
  submitViaApi,
} from '@test/support/fixtures';
import { spawnInstances } from '@test/support/spawn-instances';
import { peekMessages } from '@test/support/sqs';
import { createTestApp } from '@test/support/test-app';
import type { TestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID, TestIssuer } from '@test/support/test-issuer';
import { createTestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';

const OUTBOX_WAIT = { timeoutMs: 20_000, intervalMs: 100 } as const;
const CRASH_TIMEOUT_MS = 30_000;

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

const outboxState = async (databaseUrl: string): Promise<Record<string, unknown> | undefined> =>
  (
    await queryRows(
      databaseUrl,
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE published_at IS NULL)::int AS unpublished
         FROM outbox_messages`,
    )
  )[0];

const publishedEventIds = async (app: TestApp): Promise<string[]> =>
  (await peekMessages(app.sqs, app.queueUrls.walletEvents))
    .map((message) => {
      const body: unknown = JSON.parse(message.body);
      return String(
        typeof body === 'object' && body !== null ? Reflect.get(body, 'eventId') : body,
      );
    })
    .sort();

const pendingEventPayload = (eventId: string): string =>
  JSON.stringify({
    eventId,
    eventType: 'WalletBalanceChanged',
    aggregateId: eventId,
    correlationId: `corr-${eventId}`,
    occurredAt: new Date().toISOString(),
    version: 1,
    data: { walletId: eventId },
  });

const writeSnapshot = async (databaseUrl: string): Promise<Record<string, unknown> | undefined> =>
  (
    await queryRows(
      databaseUrl,
      `SELECT (SELECT count(*)::int FROM wager_transactions) AS transactions,
              (SELECT count(*)::int FROM ledger_entries) AS "ledgerEntries",
              (SELECT count(*)::int FROM idempotency_records) AS "idempotencyRecords",
              (SELECT count(*)::int FROM outbox_messages) AS "outboxMessages",
              (SELECT json_agg(json_build_object('balance', balance::text, 'version', version))
                 FROM wallets) AS wallets`,
    )
  )[0];

describe('§5.4 eventos só depois do commit', () => {
  it('leaves an outbox row of an open transaction unclaimed and publishes it after the commit', async () => {
    const database = await createTestDatabase();
    const app = await createTestApp({
      roles: ['outbox'],
      env: { DATABASE_URL: database.appUrl },
    });
    const writer = new Client({ connectionString: database.superuserUrl });
    await writer.connect();
    const pendingId = randomUUID();
    try {
      await writer.query('BEGIN');
      await writer.query(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
         VALUES ($1, $1, 'WalletBalanceChanged', $2::jsonb, now(), now())`,
        [pendingId, pendingEventPayload(pendingId)],
      );
      await createWalletViaUseCase(app);
      await waitFor(async () => {
        const state = await outboxState(database.superuserUrl);
        return Number(state?.total) > 0 && state?.unpublished === 0;
      }, OUTBOX_WAIT);

      const beforeCommit = await publishedEventIds(app);
      expect(beforeCommit.length).toBeGreaterThan(0);
      expect(beforeCommit).not.toContain(pendingId);
      expect(
        (
          await writer.query(
            'SELECT attempts, locked_by, published_at FROM outbox_messages WHERE id = $1',
            [pendingId],
          )
        ).rows,
      ).toEqual([{ attempts: 0, locked_by: null, published_at: null }]);

      await writer.query('COMMIT');
      await waitFor(
        async () => (await outboxState(database.superuserUrl))?.unpublished === 0,
        OUTBOX_WAIT,
      );

      expect(await publishedEventIds(app)).toEqual([...beforeCommit, pendingId].sort());
    } finally {
      await writer.end();
      await app.stop();
    }
  });

  it('leaves nothing behind when api.before_commit kills the api process', async () => {
    const database = await createTestDatabase();
    const queues = await createTestQueues();
    const issuer = await TestIssuer.start();
    const apis = await spawnInstances({
      role: 'api',
      count: 1,
      env: {
        DATABASE_URL: database.appUrl,
        ...queues.env,
        ...issuer.authConfig,
        ...faultEnv('api.before_commit'),
      },
    });
    try {
      const api = apis.instance(0);
      const wallet = await createWalletViaApi(
        api.baseUrl,
        await issuer.token({ role: 'operator' }),
      );
      const before = await writeSnapshot(database.superuserUrl);
      const request = betCommand({ wallet });

      const failure = await submitViaApi(
        api.baseUrl,
        await issuer.token({ role: 'provider', providerId: TEST_PROVIDER_ID }),
        request,
      ).then(
        (response) => response.status,
        (reason: unknown) => reason,
      );

      expect(failure).toBeInstanceOf(Error);
      expect(await api.waitForExit(CRASH_TIMEOUT_MS)).toBe(FAULT_KILL_EXIT_CODE);
      expect(await writeSnapshot(database.superuserUrl)).toEqual(before);
      expect(
        await queryRows(
          database.superuserUrl,
          'SELECT id FROM wager_transactions WHERE external_transaction_id = $1',
          [request.body.externalTransactionId],
        ),
      ).toEqual([]);
    } finally {
      await apis.stop();
      await issuer.stop();
    }
  });
});
