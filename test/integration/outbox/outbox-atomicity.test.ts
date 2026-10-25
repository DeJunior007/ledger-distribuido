import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { WalletAlreadyExistsError } from '@application/errors/wallet-already-exists.error';
import { createWalletViaUseCase } from '@test/support/fixtures';
import { countMessages } from '@test/support/sqs';
import { createTestApp } from '@test/support/test-app';
import type { TestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { waitFor } from '@test/support/wait-for';

const WAIT = { timeoutMs: 20_000, intervalMs: 100 } as const;
const TEST_TIMEOUT_MS = 60_000;

interface OutboxRow {
  readonly id: string;
  readonly aggregate_id: string;
  readonly published_at: Date | null;
  readonly locked_by: string | null;
}

const INSERT_OUTBOX_SQL = `INSERT INTO outbox_messages
  (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
VALUES ($1, $2, 'WalletBalanceChanged', $3::jsonb, now(), now())`;

const openClient = async (url: string): Promise<Client> => {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
};

const outboxRows = async (url: string): Promise<OutboxRow[]> => {
  const client = await openClient(url);
  try {
    const result = await client.query<OutboxRow>(
      'SELECT id, aggregate_id, published_at, locked_by FROM outbox_messages ORDER BY id',
    );
    return result.rows;
  } finally {
    await client.end();
  }
};

const countRows = async (url: string, table: string): Promise<number> => {
  const client = await openClient(url);
  try {
    const result = await client.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM ${table}`,
    );
    return result.rows[0]?.total ?? 0;
  } finally {
    await client.end();
  }
};

const insertOutboxRow = async (client: Client, id: string): Promise<void> => {
  const aggregateId = randomUUID();
  const payload = {
    eventId: id,
    eventType: 'WalletBalanceChanged',
    aggregateId,
    correlationId: `corr-${id}`,
    occurredAt: new Date().toISOString(),
    version: 1,
    data: { walletId: aggregateId },
  };
  await client.query(INSERT_OUTBOX_SQL, [id, aggregateId, JSON.stringify(payload)]);
};

const publishedIds = (rows: readonly OutboxRow[]): string[] =>
  rows.filter((row) => row.published_at !== null).map((row) => row.id);

const waitForPublished = (database: TestDatabase, count: number): Promise<void> =>
  waitFor(async () => publishedIds(await outboxRows(database.superuserUrl)).length === count, WAIT);

const totalInQueue = async (app: TestApp): Promise<number> =>
  (await countMessages(app.sqs, app.queueUrls.walletEvents)).total;

describe('outbox atomicity', () => {
  it(
    'leaves no outbox row behind when the use case rolls back',
    async () => {
      const database = await createTestDatabase();
      const app = await createTestApp({
        roles: ['outbox'],
        env: { DATABASE_URL: database.appUrl },
      });
      try {
        const wallet = await createWalletViaUseCase(app);
        const committed = await outboxRows(database.superuserUrl);
        expect(committed).toHaveLength(2);
        expect(committed.every((row) => row.aggregate_id === wallet.id)).toBe(true);

        const failure = await createWalletViaUseCase(app, { playerId: wallet.playerId }).then(
          () => undefined,
          (reason: unknown) => reason,
        );

        expect(failure).toBeInstanceOf(WalletAlreadyExistsError);
        expect((await outboxRows(database.superuserUrl)).map((row) => row.id)).toEqual(
          committed.map((row) => row.id),
        );
        expect(await countRows(database.superuserUrl, 'wallets')).toBe(1);
        expect(await countRows(database.superuserUrl, 'wager_transactions')).toBe(1);
        await waitForPublished(database, 2);
        expect(await totalInQueue(app)).toBe(2);
      } finally {
        await app.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'does not claim a row inserted by a transaction that is still open',
    async () => {
      const database = await createTestDatabase();
      const app = await createTestApp({
        roles: ['outbox'],
        env: { DATABASE_URL: database.appUrl },
      });
      const writer = await openClient(database.superuserUrl);
      const pendingId = randomUUID();
      try {
        await writer.query('BEGIN');
        await insertOutboxRow(writer, pendingId);

        await createWalletViaUseCase(app);
        await waitForPublished(database, 2);

        const rows = await outboxRows(database.superuserUrl);
        expect(rows.map((row) => row.id)).not.toContain(pendingId);
        expect(await totalInQueue(app)).toBe(2);

        await writer.query('COMMIT');
        await waitForPublished(database, 3);
        expect(publishedIds(await outboxRows(database.superuserUrl))).toContain(pendingId);
        expect(await totalInQueue(app)).toBe(3);
      } finally {
        await writer.end();
        await app.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'skips a committed row locked by an open transaction and publishes it after the lock goes away',
    async () => {
      const database = await createTestDatabase();
      const lockedId = randomUUID();
      const seeder = await openClient(database.superuserUrl);
      try {
        await insertOutboxRow(seeder, lockedId);
      } finally {
        await seeder.end();
      }
      const locker = await openClient(database.superuserUrl);
      let app: TestApp | undefined;
      try {
        await locker.query('BEGIN');
        await locker.query('SELECT id FROM outbox_messages WHERE id = $1 FOR UPDATE', [lockedId]);
        app = await createTestApp({ roles: ['outbox'], env: { DATABASE_URL: database.appUrl } });
        const wallet = await createWalletViaUseCase(app);
        await waitFor(async () => {
          const rows = await outboxRows(database.superuserUrl);
          const walletRows = rows.filter((row) => row.aggregate_id === wallet.id);
          return walletRows.length === 2 && walletRows.every((row) => row.published_at !== null);
        }, WAIT);

        const locked = (await outboxRows(database.superuserUrl)).find((row) => row.id === lockedId);
        expect(locked).toMatchObject({ published_at: null, locked_by: null });
        expect(await totalInQueue(app)).toBe(2);

        await locker.query('COMMIT');
        await waitForPublished(database, 3);
        expect(publishedIds(await outboxRows(database.superuserUrl))).toContain(lockedId);
        expect(await totalInQueue(app)).toBe(3);
      } finally {
        await locker.end();
        await app?.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
