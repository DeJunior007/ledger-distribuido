import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { loadConfig } from '@infrastructure/config/env.schema';
import { MikroOrmUnitOfWork } from '@infrastructure/persistence/mikro-orm-unit-of-work';
import { closeOrmInstances, openOrmInstances } from '@infrastructure/persistence/orm-instances';
import type { OrmInstances } from '@infrastructure/persistence/orm-instances';
import { OutboxMessage } from '@domain/messaging/outbox-message';
import type { OutboxMessageState } from '@domain/messaging/outbox-message';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';

const WALLET_ID = '0198b000-0000-7000-8000-000000000001';
const PAST = new Date('2020-01-01T00:00:00.000Z');
const FUTURE = new Date('2100-01-01T00:00:00.000Z');
const LEASE_MS = 30_000;

class NothingClaimedError extends Error {
  constructor() {
    super('no outbox message was claimed');
    this.name = 'NothingClaimedError';
  }
}

interface StoredOutboxRow {
  readonly id: string;
  readonly attempts: number;
  readonly permanent_failures: number;
  readonly next_attempt_at: Date;
  readonly locked_until: Date | null;
  readonly locked_by: string | null;
  readonly published_at: Date | null;
  readonly parked_at: Date | null;
  readonly last_error_code: string | null;
}

const outboxId = (index: number): string =>
  `0198b000-0000-7000-8000-${String(index).padStart(12, '0')}`;

const minutesAfter = (base: Date, minutes: number): Date =>
  new Date(base.getTime() + minutes * 60_000);

const messageState = (
  index: number,
  overrides: Partial<OutboxMessageState> = {},
): OutboxMessageState => ({
  id: outboxId(index),
  aggregateId: WALLET_ID,
  eventType: 'WalletBalanceChanged',
  payload: { eventId: outboxId(index), data: { walletId: WALLET_ID } },
  occurredAt: PAST,
  attempts: 0,
  permanentFailures: 0,
  nextAttemptAt: PAST,
  lockedUntil: undefined,
  lockedBy: undefined,
  publishedAt: undefined,
  parkedAt: undefined,
  lastErrorCode: undefined,
  ...overrides,
});

const idsOf = (messages: readonly OutboxMessage[]): string[] =>
  messages.map((message) => message.id);

describe('MikroOrmOutboxRepository', () => {
  let database: TestDatabase;
  let instances: OrmInstances;
  let uow: MikroOrmUnitOfWork;
  let client: Client;

  const enqueue = (...states: OutboxMessageState[]): Promise<void> =>
    uow.run('short', async (repos) => {
      for (const state of states) {
        repos.outbox.enqueue(OutboxMessage.rehydrate(state));
      }
      await repos.flush();
    });

  const claim = (instanceId: string, limit: number): Promise<OutboxMessage[]> =>
    uow.run('short', (repos) => repos.outbox.claimDue({ instanceId, leaseMs: LEASE_MS, limit }));

  const stored = async (id: string): Promise<StoredOutboxRow | undefined> => {
    const result = await client.query<StoredOutboxRow>(
      `SELECT id, attempts, permanent_failures, next_attempt_at, locked_until, locked_by,
              published_at, parked_at, last_error_code
       FROM outbox_messages WHERE id = $1`,
      [id],
    );
    return result.rows[0];
  };

  const databaseNow = async (): Promise<Date> => {
    const result = await client.query<{ now: Date }>('SELECT now() AS now');
    return result.rows[0]?.now ?? PAST;
  };

  beforeEach(async () => {
    database = await createTestDatabase();
    const config = loadConfig({ DATABASE_URL: database.appUrl }, { role: 'api' });
    instances = await openOrmInstances(config);
    uow = new MikroOrmUnitOfWork(instances, config);
    client = new Client({ connectionString: database.appUrl });
    await client.connect();
  });

  afterEach(async () => {
    await client.query(
      'UPDATE outbox_messages SET locked_until = NULL, locked_by = NULL WHERE locked_until IS NOT NULL',
    );
    await client.end();
    await closeOrmInstances(instances);
  });

  describe('enqueue', () => {
    it('persists the message with every field on flush', async () => {
      await enqueue(messageState(1, { attempts: 2, lastErrorCode: 'Throttled' }));
      const row = await stored(outboxId(1));
      expect(row).toMatchObject({
        id: outboxId(1),
        attempts: 2,
        permanent_failures: 0,
        next_attempt_at: PAST,
        locked_until: null,
        locked_by: null,
        published_at: null,
        parked_at: null,
        last_error_code: 'Throttled',
      });
    });
  });

  describe('claimDue', () => {
    it('leases only due, unpublished and unleased messages in next attempt order', async () => {
      await enqueue(
        messageState(1, { nextAttemptAt: minutesAfter(PAST, 3) }),
        messageState(2, { nextAttemptAt: minutesAfter(PAST, 1) }),
        messageState(3, { nextAttemptAt: FUTURE }),
        messageState(4, { publishedAt: PAST }),
        messageState(5, { lockedUntil: FUTURE, lockedBy: 'instance-z' }),
        messageState(6, { nextAttemptAt: minutesAfter(PAST, 2) }),
      );
      const before = await databaseNow();
      const claimed = await claim('instance-a', 10);
      expect(idsOf(claimed)).toEqual([outboxId(2), outboxId(6), outboxId(1)]);
      const leased = await stored(outboxId(2));
      expect(leased?.locked_by).toBe('instance-a');
      expect(leased?.locked_until?.getTime()).toBeGreaterThanOrEqual(before.getTime() + LEASE_MS);
      expect((await stored(outboxId(5)))?.locked_by).toBe('instance-z');
      expect((await stored(outboxId(3)))?.locked_by).toBeNull();
    });

    it('rehydrates the payload and the lease into the domain message', async () => {
      await enqueue(messageState(1));
      const [message] = await claim('instance-a', 10);
      expect(message?.toState()).toMatchObject({
        id: outboxId(1),
        aggregateId: WALLET_ID,
        eventType: 'WalletBalanceChanged',
        payload: { eventId: outboxId(1), data: { walletId: WALLET_ID } },
        occurredAt: PAST,
        lockedBy: 'instance-a',
        publishedAt: undefined,
        parkedAt: undefined,
      });
    });

    it('respects the limit and reclaims a message whose lease expired', async () => {
      await enqueue(messageState(1), messageState(2), messageState(3));
      expect(await claim('instance-a', 2)).toHaveLength(2);
      expect(idsOf(await claim('instance-b', 10))).toEqual([outboxId(3)]);
      expect(await claim('instance-c', 10)).toHaveLength(0);
      await client.query(
        `UPDATE outbox_messages SET locked_until = now() - interval '1 second' WHERE id = $1`,
        [outboxId(1)],
      );
      expect(idsOf(await claim('instance-c', 10))).toEqual([outboxId(1)]);
      expect((await stored(outboxId(1)))?.locked_by).toBe('instance-c');
    });

    it('skips rows another open claim holds instead of returning them twice', async () => {
      await enqueue(messageState(1), messageState(2), messageState(3), messageState(4));
      const firstClaimed: PromiseWithResolvers<string[]> = Promise.withResolvers();
      const release: PromiseWithResolvers<void> = Promise.withResolvers();
      const first = uow.run('short', async (repos) => {
        const claimed = await repos.outbox.claimDue({
          instanceId: 'instance-a',
          leaseMs: LEASE_MS,
          limit: 2,
        });
        firstClaimed.resolve(idsOf(claimed));
        await release.promise;
      });
      const heldByFirst = await firstClaimed.promise;
      const second = await claim('instance-b', 10);
      release.resolve();
      await first;
      expect(heldByFirst).toHaveLength(2);
      expect(second).toHaveLength(2);
      expect(idsOf(second).filter((id) => heldByFirst.includes(id))).toEqual([]);
    });

    it('never hands the same message to concurrent claims', async () => {
      const states = Array.from({ length: 20 }, (_, index) => messageState(index + 1));
      await enqueue(...states);
      const batches = await Promise.all(
        ['instance-a', 'instance-b', 'instance-c', 'instance-d', 'instance-e'].map((instance) =>
          claim(instance, 6),
        ),
      );
      const claimedIds = batches.flatMap(idsOf);
      expect(new Set(claimedIds).size).toBe(claimedIds.length);
    });
  });

  describe('markPublished', () => {
    it('marks the message published only for the instance that holds the lease', async () => {
      await enqueue(messageState(1));
      await claim('instance-a', 10);
      const publishedAt = new Date('2026-10-24T12:00:00.000Z');
      const stolen = await uow.run('short', (repos) =>
        repos.outbox.markPublished(outboxId(1), 'instance-b', publishedAt),
      );
      expect(stolen).toBe(false);
      expect((await stored(outboxId(1)))?.published_at).toBeNull();
      const owned = await uow.run('short', (repos) =>
        repos.outbox.markPublished(outboxId(1), 'instance-a', publishedAt),
      );
      expect(owned).toBe(true);
      expect(await stored(outboxId(1))).toMatchObject({
        published_at: publishedAt,
        locked_until: null,
        locked_by: null,
      });
    });

    it('returns false for a message that is already published', async () => {
      await enqueue(messageState(1, { publishedAt: PAST, lockedBy: 'instance-a' }));
      const result = await uow.run('short', (repos) =>
        repos.outbox.markPublished(outboxId(1), 'instance-a', FUTURE),
      );
      expect(result).toBe(false);
      expect((await stored(outboxId(1)))?.published_at).toEqual(PAST);
    });
  });

  describe('saveRetry', () => {
    it('saves the retry only for the instance that holds the lease', async () => {
      await enqueue(messageState(1, { permanentFailures: 2 }));
      const [claimed] = await claim('instance-a', 10);
      if (claimed === undefined) {
        throw new NothingClaimedError();
      }
      const now = new Date('2026-10-24T12:00:00.000Z');
      claimed.scheduleRetry({
        now,
        kind: 'PERMANENT',
        errorCode: 'InvalidParameterValue',
        jitterRatio: 0,
      });
      const stolen = await uow.run('short', (repos) =>
        repos.outbox.saveRetry(claimed, 'instance-b'),
      );
      expect(stolen).toBe(false);
      expect((await stored(outboxId(1)))?.attempts).toBe(0);
      const owned = await uow.run('short', (repos) =>
        repos.outbox.saveRetry(claimed, 'instance-a'),
      );
      expect(owned).toBe(true);
      expect(await stored(outboxId(1))).toMatchObject({
        attempts: 1,
        permanent_failures: 3,
        next_attempt_at: claimed.nextAttemptAt,
        parked_at: now,
        last_error_code: 'InvalidParameterValue',
        locked_until: null,
        locked_by: null,
      });
    });
  });

  describe('requeueParked', () => {
    it('makes parked unpublished messages due now, up to the limit when one is given', async () => {
      await enqueue(
        messageState(1, { parkedAt: PAST, nextAttemptAt: FUTURE }),
        messageState(2, { parkedAt: PAST, nextAttemptAt: FUTURE }),
        messageState(3, { parkedAt: PAST, nextAttemptAt: FUTURE }),
        messageState(4, { parkedAt: PAST, nextAttemptAt: FUTURE, publishedAt: PAST }),
        messageState(5, { nextAttemptAt: FUTURE }),
      );
      const limited = await uow.run('short', (repos) => repos.outbox.requeueParked(2));
      expect(limited).toBe(2);
      expect((await stored(outboxId(1)))?.next_attempt_at.getTime()).toBeLessThan(FUTURE.getTime());
      expect((await stored(outboxId(2)))?.next_attempt_at.getTime()).toBeLessThan(FUTURE.getTime());
      expect((await stored(outboxId(3)))?.next_attempt_at).toEqual(FUTURE);
      const all = await uow.run('short', (repos) => repos.outbox.requeueParked(undefined));
      expect(all).toBe(3);
      expect((await stored(outboxId(3)))?.next_attempt_at.getTime()).toBeLessThan(FUTURE.getTime());
      expect((await stored(outboxId(4)))?.next_attempt_at).toEqual(FUTURE);
      expect((await stored(outboxId(5)))?.next_attempt_at).toEqual(FUTURE);
    });
  });

  describe('gauges', () => {
    it('returns numeric gauges for pending, parked, stuck and lag', async () => {
      const now = await databaseNow();
      await enqueue(
        messageState(1, { occurredAt: new Date(now.getTime() - 120_000) }),
        messageState(2, { occurredAt: new Date(now.getTime() - 60_000), attempts: 10 }),
        messageState(3, { occurredAt: PAST, parkedAt: PAST }),
        messageState(4, { occurredAt: PAST, publishedAt: PAST }),
      );
      const gauges = await uow.run('short', (repos) => repos.outbox.gauges(now));
      expect(gauges.pending).toBe(2);
      expect(gauges.parked).toBe(1);
      expect(gauges.stuck).toBe(1);
      expect(typeof gauges.lagSeconds).toBe('number');
      expect(gauges.lagSeconds).toBeGreaterThanOrEqual(120);
      expect(gauges.lagSeconds).toBeLessThan(180);
    });

    it('reports zero lag when nothing is pending', async () => {
      const gauges = await uow.run('short', (repos) => repos.outbox.gauges(PAST));
      expect(gauges).toEqual({ pending: 0, parked: 0, stuck: 0, lagSeconds: 0 });
    });
  });
});
