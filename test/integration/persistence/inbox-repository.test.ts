import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import { InboxMessage } from '@domain/messaging/inbox-message';
import { loadConfig } from '@infrastructure/config/env.schema';
import { MikroOrmUnitOfWork } from '@infrastructure/persistence/mikro-orm-unit-of-work';
import { closeOrmInstances, openOrmInstances } from '@infrastructure/persistence/orm-instances';
import type { OrmInstances } from '@infrastructure/persistence/orm-instances';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';

const CONSUMER = 'wager-transactions-consumer';
const AUDIT_CONSUMER = 'wallet-events-audit';
const MESSAGE_ID = 'message-0001';
const PAYLOAD_HASH = 'b'.repeat(64);
const RECEIVED_AT = new Date('2026-10-24T12:00:00.123Z');
const PROCESSED_AT = new Date('2026-10-24T12:00:01.456Z');

interface StoredRow {
  readonly consumer_name: string;
  readonly payload_hash: string;
  readonly received_at: Date;
  readonly processed_at: Date | null;
}

const received = (consumerName: string = CONSUMER, payloadHash: string = PAYLOAD_HASH) =>
  InboxMessage.receive({ consumerName, messageId: MESSAGE_ID, payloadHash, now: RECEIVED_AT });

const failureOf = <T>(promise: Promise<T>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );

const storedRows = async (database: TestDatabase): Promise<StoredRow[]> => {
  const client = new Client({ connectionString: database.appUrl });
  await client.connect();
  try {
    const result = await client.query<StoredRow>(
      `SELECT consumer_name, payload_hash, received_at, processed_at
       FROM inbox_messages
       WHERE message_id = $1
       ORDER BY consumer_name`,
      [MESSAGE_ID],
    );
    return result.rows;
  } finally {
    await client.end();
  }
};

describe('MikroOrmInboxRepository', () => {
  let database: TestDatabase;
  let instances: OrmInstances;
  let uow: MikroOrmUnitOfWork;

  beforeEach(async () => {
    database = await createTestDatabase();
    const config = loadConfig({ DATABASE_URL: database.appUrl }, { role: 'api' });
    instances = await openOrmInstances(config);
    uow = new MikroOrmUnitOfWork(instances, config);
  });

  afterEach(async () => {
    await closeOrmInstances(instances);
  });

  it('inserts a message once and answers false to every later attempt without throwing', async () => {
    const attempts = await uow.run('write', async (repos) => [
      await repos.inbox.tryInsert(received()),
      await repos.inbox.tryInsert(received()),
    ]);
    const later = await uow.run('write', (repos) =>
      repos.inbox.tryInsert(received(CONSUMER, 'c'.repeat(64))),
    );

    expect(attempts).toEqual([true, false]);
    expect(later).toBe(false);
    const rows = await storedRows(database);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload_hash).toBe(PAYLOAD_HASH);
    expect(rows[0]?.received_at.toISOString()).toBe(RECEIVED_AT.toISOString());
    expect(rows[0]?.processed_at).toBeNull();
  });

  it('keeps the same message id apart for different consumers', async () => {
    const inserted = await uow.run('write', async (repos) => [
      await repos.inbox.tryInsert(received(CONSUMER)),
      await repos.inbox.tryInsert(received(AUDIT_CONSUMER)),
    ]);

    expect(inserted).toEqual([true, true]);
    expect((await storedRows(database)).map((row) => row.consumer_name)).toEqual([
      CONSUMER,
      AUDIT_CONSUMER,
    ]);
  });

  it('finds an inserted message inside and outside a transaction', async () => {
    const message = received();
    const insideFound = await uow.run('write', async (repos) => {
      await repos.inbox.tryInsert(message);
      return repos.inbox.find(CONSUMER, MESSAGE_ID);
    });
    const [outsideFound, missing] = await uow.read(async (repos) => [
      await repos.inbox.find(CONSUMER, MESSAGE_ID),
      await repos.inbox.find(AUDIT_CONSUMER, MESSAGE_ID),
    ]);

    expect(insideFound?.toState()).toEqual(message.toState());
    expect(outsideFound?.toState()).toEqual(message.toState());
    expect(missing).toBeUndefined();
  });

  it('writes processed_at when a message is marked as processed', async () => {
    const found = await uow.run('write', async (repos) => {
      const message = received();
      await repos.inbox.tryInsert(message);
      message.markProcessed(PROCESSED_AT);
      await repos.inbox.markProcessed(message);
      return repos.inbox.find(CONSUMER, MESSAGE_ID);
    });

    expect(found?.processedAt?.toISOString()).toBe(PROCESSED_AT.toISOString());
    const rows = await storedRows(database);
    expect(rows[0]?.processed_at?.toISOString()).toBe(PROCESSED_AT.toISOString());
  });

  it('marks a message inserted by an earlier transaction as processed', async () => {
    await uow.run('write', (repos) => repos.inbox.tryInsert(received()));

    await uow.run('write', async (repos) => {
      const message = await repos.inbox.find(CONSUMER, MESSAGE_ID);
      if (message !== undefined) {
        message.markProcessed(PROCESSED_AT);
        await repos.inbox.markProcessed(message);
      }
    });

    const rows = await storedRows(database);
    expect(rows[0]?.processed_at?.toISOString()).toBe(PROCESSED_AT.toISOString());
  });

  it('refuses to mark a message that carries no processing time', async () => {
    const failure = await failureOf(
      uow.run('write', async (repos) => {
        await repos.inbox.tryInsert(received());
        await repos.inbox.markProcessed(received());
      }),
    );

    expect(failure).toBeInstanceOf(TechnicalError);
    expect(failure).toMatchObject({ errorClass: ErrorClass.Deterministic });
    expect(await storedRows(database)).toHaveLength(0);
  });
});
