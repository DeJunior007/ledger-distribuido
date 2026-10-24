import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { HouseAccountPurpose } from '@domain/wallet/house-account';
import { loadConfig } from '@infrastructure/config/env.schema';
import { MikroOrmUnitOfWork } from '@infrastructure/persistence/mikro-orm-unit-of-work';
import { closeOrmInstances, openOrmInstances } from '@infrastructure/persistence/orm-instances';
import type { OrmInstances } from '@infrastructure/persistence/orm-instances';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';

const CURRENCY = 'BRL';
const NOW = new Date('2026-10-24T12:00:00.123Z');
const LATER = new Date('2026-10-24T13:00:00.000Z');

interface StoredAccount {
  readonly id: string;
  readonly currency: string;
  readonly purpose: string;
}

const storedAccounts = async (database: TestDatabase): Promise<StoredAccount[]> => {
  const client = new Client({ connectionString: database.superuserUrl });
  await client.connect();
  try {
    const result = await client.query<StoredAccount>(
      'SELECT id, currency, purpose FROM house_accounts ORDER BY currency, purpose',
    );
    return result.rows;
  } finally {
    await client.end();
  }
};

describe('MikroOrmHouseAccountRepository', () => {
  let database: TestDatabase;
  let opened: OrmInstances[] = [];

  const openUnitOfWork = async (): Promise<MikroOrmUnitOfWork> => {
    const config = loadConfig({ DATABASE_URL: database.appUrl }, { role: 'api' });
    const instances = await openOrmInstances(config);
    opened.push(instances);
    return new MikroOrmUnitOfWork(instances, config);
  };

  beforeEach(async () => {
    database = await createTestDatabase();
  });

  afterEach(async () => {
    await Promise.all(opened.map(closeOrmInstances));
    opened = [];
  });

  it('creates the account when it does not exist yet', async () => {
    const uow = await openUnitOfWork();
    const id = crypto.randomUUID();
    const account = await uow.run('write', (repos) =>
      repos.houseAccounts.ensure(CURRENCY, HouseAccountPurpose.Gaming, id, NOW),
    );
    expect(account.id).toBe(id);
    expect(String(account.currency)).toBe(CURRENCY);
    expect(account.purpose).toBe(HouseAccountPurpose.Gaming);
    expect(account.createdAt).toBeInstanceOf(Date);
    expect(account.createdAt.toISOString()).toBe(NOW.toISOString());
    expect(await storedAccounts(database)).toEqual([
      { id, currency: CURRENCY, purpose: HouseAccountPurpose.Gaming },
    ]);
  });

  it('reuses the existing account and ignores the id offered for a new one', async () => {
    const uow = await openUnitOfWork();
    const firstId = crypto.randomUUID();
    await uow.run('write', (repos) =>
      repos.houseAccounts.ensure(CURRENCY, HouseAccountPurpose.Gaming, firstId, NOW),
    );
    const again = await uow.run('write', async (repos) => ({
      ensured: await repos.houseAccounts.ensure(
        CURRENCY,
        HouseAccountPurpose.Gaming,
        crypto.randomUUID(),
        LATER,
      ),
      ensuredTwice: await repos.houseAccounts.ensure(
        CURRENCY,
        HouseAccountPurpose.Gaming,
        crypto.randomUUID(),
        LATER,
      ),
    }));
    expect(again.ensured.id).toBe(firstId);
    expect(again.ensured.createdAt.toISOString()).toBe(NOW.toISOString());
    expect(again.ensuredTwice.id).toBe(firstId);
    expect(await storedAccounts(database)).toEqual([
      { id: firstId, currency: CURRENCY, purpose: HouseAccountPurpose.Gaming },
    ]);
  });

  it('keeps one account per currency and purpose', async () => {
    const uow = await openUnitOfWork();
    const gamingId = crypto.randomUUID();
    const fundingId = crypto.randomUUID();
    const usdGamingId = crypto.randomUUID();
    await uow.run('write', async (repos) => {
      await repos.houseAccounts.ensure(CURRENCY, HouseAccountPurpose.Gaming, gamingId, NOW);
      await repos.houseAccounts.ensure(CURRENCY, HouseAccountPurpose.Funding, fundingId, NOW);
      await repos.houseAccounts.ensure('USD', HouseAccountPurpose.Gaming, usdGamingId, NOW);
    });
    expect(await storedAccounts(database)).toEqual([
      { id: fundingId, currency: CURRENCY, purpose: HouseAccountPurpose.Funding },
      { id: gamingId, currency: CURRENCY, purpose: HouseAccountPurpose.Gaming },
      { id: usdGamingId, currency: 'USD', purpose: HouseAccountPurpose.Gaming },
    ]);
  });

  it('converges on a single row when two transactions ensure the same account at once', async () => {
    const uow = await openUnitOfWork();
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const firstInserted: PromiseWithResolvers<void> = Promise.withResolvers();
    const releaseFirst: PromiseWithResolvers<void> = Promise.withResolvers();
    const first = uow.run('write', async (repos) => {
      const account = await repos.houseAccounts.ensure(
        CURRENCY,
        HouseAccountPurpose.Gaming,
        firstId,
        NOW,
      );
      firstInserted.resolve();
      await releaseFirst.promise;
      return account;
    });
    await firstInserted.promise;
    const second = uow.run('write', (repos) =>
      repos.houseAccounts.ensure(CURRENCY, HouseAccountPurpose.Gaming, secondId, LATER),
    );
    await Bun.sleep(200);
    releaseFirst.resolve();
    const [fromFirst, fromSecond] = await Promise.all([first, second]);
    expect(fromFirst.id).toBe(firstId);
    expect(fromSecond.id).toBe(firstId);
    expect(await storedAccounts(database)).toEqual([
      { id: firstId, currency: CURRENCY, purpose: HouseAccountPurpose.Gaming },
    ]);
  });

  it('converges on a single row when two ensures race without coordination', async () => {
    const uow = await openUnitOfWork();
    const [left, right] = await Promise.all([
      uow.run('write', (repos) =>
        repos.houseAccounts.ensure(CURRENCY, HouseAccountPurpose.Funding, crypto.randomUUID(), NOW),
      ),
      uow.run('write', (repos) =>
        repos.houseAccounts.ensure(CURRENCY, HouseAccountPurpose.Funding, crypto.randomUUID(), NOW),
      ),
    ]);
    expect(left.id).toBe(right.id);
    expect(await storedAccounts(database)).toEqual([
      { id: left.id, currency: CURRENCY, purpose: HouseAccountPurpose.Funding },
    ]);
  });

  it('finds an account by currency and purpose', async () => {
    const uow = await openUnitOfWork();
    const gamingId = crypto.randomUUID();
    await uow.run('write', (repos) =>
      repos.houseAccounts.ensure(CURRENCY, HouseAccountPurpose.Gaming, gamingId, NOW),
    );
    const found = await uow.run('short', async (repos) => ({
      gaming: await repos.houseAccounts.findByCurrencyAndPurpose(
        CURRENCY,
        HouseAccountPurpose.Gaming,
      ),
      funding: await repos.houseAccounts.findByCurrencyAndPurpose(
        CURRENCY,
        HouseAccountPurpose.Funding,
      ),
    }));
    expect(found.gaming?.id).toBe(gamingId);
    expect(found.gaming?.purpose).toBe(HouseAccountPurpose.Gaming);
    expect(found.gaming?.createdAt.toISOString()).toBe(NOW.toISOString());
    expect(found.funding).toBeUndefined();
  });
});
