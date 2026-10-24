import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MikroORM, ref } from '@mikro-orm/postgresql';
import type { EntityManager } from '@mikro-orm/postgresql';
import { loadConfig } from '@infrastructure/config/env.schema';
import { buildOrmOptions } from '@infrastructure/persistence/mikro-orm.config';
import { HouseAccountRecord } from '@infrastructure/persistence/records/house-accounts.record';
import { IdempotencyRecordRecord } from '@infrastructure/persistence/records/idempotency-records.record';
import { InboxMessageRecord } from '@infrastructure/persistence/records/inbox-messages.record';
import { LedgerEntryRecord } from '@infrastructure/persistence/records/ledger-entries.record';
import { OutboxMessageRecord } from '@infrastructure/persistence/records/outbox-messages.record';
import { PendingReferenceRetryRecord } from '@infrastructure/persistence/records/pending-reference-retries.record';
import { ReconciliationRunRecord } from '@infrastructure/persistence/records/reconciliation-runs.record';
import { ScheduledJobRecord } from '@infrastructure/persistence/records/scheduled-jobs.record';
import { WagerTransactionRecord } from '@infrastructure/persistence/records/wager-transactions.record';
import { WalletRecord } from '@infrastructure/persistence/records/wallets.record';
import { ENTITY_SCHEMAS } from '@infrastructure/persistence/schemas';
import { createTestDatabase } from '@test/support/test-database';

const WALLET_ID = '0196a000-0000-7000-8000-000000000001';
const HOUSE_ID = '0196a000-0000-7000-8000-000000000002';
const TX_ID = '0196a000-0000-7000-8000-000000000003';
const REFERENCE_TX_ID = '0196a000-0000-7000-8000-000000000004';
const PLAYER_ID = '0196a000-0000-7000-8000-000000000005';
const OUTBOX_ID = '0196a000-0000-7000-8000-000000000006';
const LEDGER_WALLET_ID = '0196a000-0000-7000-8000-000000000007';
const LEDGER_HOUSE_ID = '0196a000-0000-7000-8000-000000000008';
const RUN_ID = '0196a000-0000-7000-8000-000000000009';
const FUNDING_ID = '0196a000-0000-7000-8000-0000000000f1';
const OPENING_TX_ID = '0196a000-0000-7000-8000-0000000000f2';
const FUNDED_WALLET_ID = '0196a000-0000-7000-8000-0000000000f3';
const FUNDED_PLAYER_ID = '0196a000-0000-7000-8000-0000000000f4';
const OPENING_WALLET_ENTRY_ID = '0196a000-0000-7000-8000-0000000000a1';
const OPENING_HOUSE_ENTRY_ID = '0196a000-0000-7000-8000-0000000000a2';
const HASH = 'a'.repeat(64);
const NOW = new Date('2026-10-24T12:00:00.000Z');
const LATER = new Date('2026-10-24T12:00:05.000Z');

let orm: MikroORM;

const fresh = (): EntityManager => orm.em.fork({ clear: true });

const seedWalletAndHouse = async (): Promise<void> => {
  const em = fresh();
  em.persist(
    new WalletRecord({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      currency: 'BRL',
      balance: '0.00',
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
  em.persist(
    new HouseAccountRecord({ id: HOUSE_ID, currency: 'BRL', purpose: 'GAMING', createdAt: NOW }),
  );
  await em.flush();
};

const newTransaction = (
  id: string,
  externalId: string,
  overrides: Partial<ConstructorParameters<typeof WagerTransactionRecord>[0]> = {},
): WagerTransactionRecord =>
  new WagerTransactionRecord({
    id,
    providerId: 'provider-a',
    externalTransactionId: externalId,
    idempotencyKey: `key-${externalId}`,
    payloadHash: HASH,
    wallet: ref(WalletRecord, WALLET_ID),
    playerId: PLAYER_ID,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    amount: '10.00',
    currency: 'BRL',
    referenceExternalTransactionId: null,
    referenceTransaction: null,
    status: 'PROCESSED',
    failureCode: null,
    balanceSnapshotAmount: '90.00',
    balanceSnapshotCurrency: 'BRL',
    correlationId: 'corr-1',
    createdAt: NOW,
    processedAt: LATER,
    updatedAt: LATER,
    ...overrides,
  });

const newEntry = (
  id: string,
  transactionId: string,
  direction: string,
  amount: string,
  account: Partial<ConstructorParameters<typeof LedgerEntryRecord>[0]>,
): LedgerEntryRecord =>
  new LedgerEntryRecord({
    id,
    transaction: ref(WagerTransactionRecord, transactionId),
    accountKind: account.wallet === undefined ? 'HOUSE' : 'WALLET',
    wallet: null,
    houseAccount: null,
    direction,
    amount,
    currency: 'BRL',
    balanceBefore: null,
    balanceAfter: null,
    walletVersion: null,
    createdAt: NOW,
    ...account,
  });

const seedTransactions = async (): Promise<void> => {
  const reference = fresh();
  reference.persist(newTransaction(REFERENCE_TX_ID, 'ext-ref'));
  await reference.flush();
  const win = fresh();
  win.persist(
    newTransaction(TX_ID, 'ext-1', {
      kind: 'WIN',
      referenceExternalTransactionId: 'ext-ref',
      referenceTransaction: ref(WagerTransactionRecord, REFERENCE_TX_ID),
    }),
  );
  await win.flush();
};

describe('entity schemas', () => {
  beforeEach(async () => {
    const database = await createTestDatabase();
    const config = loadConfig({ MIGRATION_DATABASE_URL: database.ownerUrl }, { role: 'migrate' });
    orm = await MikroORM.init({
      ...buildOrmOptions('migrator', config),
      entities: ENTITY_SCHEMAS,
    });
    await seedWalletAndHouse();
  });

  afterEach(async () => {
    await orm.close(true);
  });

  it('proposes no column changes against the migrated database', async () => {
    const sql = await orm.schema.getUpdateSchemaSQL({ wrap: false });
    const columnChanges = sql
      .split('\n')
      .filter((line) => /alter table .* (add|drop|alter) column/i.test(line))
      .filter((line) => !/alter column "\w+" type text using \("\w+"::text\);$/.test(line));
    expect(columnChanges).toEqual([]);
  });

  it('round-trips wallets and house accounts', async () => {
    const wallet = await fresh().findOneOrFail(WalletRecord, WALLET_ID);
    expect(wallet).toBeInstanceOf(WalletRecord);
    expect(wallet.balance).toBe('0.00');
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe('BRL');
    expect(wallet.createdAt.getTime()).toBe(NOW.getTime());
    const house = await fresh().findOneOrFail(HouseAccountRecord, HOUSE_ID);
    expect(house.purpose).toBe('GAMING');
  });

  it('round-trips wager transactions with self reference', async () => {
    await seedTransactions();
    const found = await fresh().findOneOrFail(WagerTransactionRecord, TX_ID);
    expect(found.wallet.id).toBe(WALLET_ID);
    expect(found.referenceTransaction?.id).toBe(REFERENCE_TX_ID);
    expect(found.amount).toBe('10.00');
    expect(found.balanceSnapshotAmount).toBe('90.00');
    expect(found.processedAt?.getTime()).toBe(LATER.getTime());
    expect(found.failureCode).toBeNull();
  });

  it('round-trips ledger entries and increments the wallet version', async () => {
    const funded = fresh();
    funded.persist(
      new WalletRecord({
        id: FUNDED_WALLET_ID,
        playerId: FUNDED_PLAYER_ID,
        currency: 'BRL',
        balance: '100.00',
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    funded.persist(
      new HouseAccountRecord({
        id: FUNDING_ID,
        currency: 'BRL',
        purpose: 'FUNDING',
        createdAt: NOW,
      }),
    );
    funded.persist(
      newTransaction(OPENING_TX_ID, 'opening', {
        wallet: ref(WalletRecord, FUNDED_WALLET_ID),
        playerId: FUNDED_PLAYER_ID,
        providerId: '__system__',
        kind: 'OPENING',
        amount: '100.00',
        balanceSnapshotAmount: '100.00',
      }),
    );
    funded.persist(
      newEntry(OPENING_WALLET_ENTRY_ID, OPENING_TX_ID, 'CREDIT', '100.00', {
        wallet: ref(WalletRecord, FUNDED_WALLET_ID),
        balanceBefore: '0.00',
        balanceAfter: '100.00',
        walletVersion: 1,
      }),
    );
    funded.persist(
      newEntry(OPENING_HOUSE_ENTRY_ID, OPENING_TX_ID, 'DEBIT', '100.00', {
        houseAccount: ref(HouseAccountRecord, FUNDING_ID),
      }),
    );
    await funded.flush();

    const bet = fresh();
    bet.persist(
      newTransaction(TX_ID, 'ext-1', {
        wallet: ref(WalletRecord, FUNDED_WALLET_ID),
        playerId: FUNDED_PLAYER_ID,
      }),
    );
    bet.persist(
      newEntry(LEDGER_WALLET_ID, TX_ID, 'DEBIT', '10.00', {
        wallet: ref(WalletRecord, FUNDED_WALLET_ID),
        balanceBefore: '100.00',
        balanceAfter: '90.00',
        walletVersion: 2,
      }),
    );
    bet.persist(
      newEntry(LEDGER_HOUSE_ID, TX_ID, 'CREDIT', '10.00', {
        houseAccount: ref(HouseAccountRecord, HOUSE_ID),
      }),
    );
    const wallet = await bet.findOneOrFail(WalletRecord, FUNDED_WALLET_ID);
    wallet.balance = '90.00';
    await bet.flush();
    expect(wallet.version).toBe(2);

    const reloaded = await fresh().findOneOrFail(WalletRecord, FUNDED_WALLET_ID);
    expect(reloaded.balance).toBe('90.00');
    expect(reloaded.version).toBe(2);
    const walletEntry = await fresh().findOneOrFail(LedgerEntryRecord, LEDGER_WALLET_ID);
    expect(walletEntry.wallet?.id).toBe(FUNDED_WALLET_ID);
    expect(walletEntry.balanceAfter).toBe('90.00');
    expect(walletEntry.walletVersion).toBe(2);
    expect(walletEntry.transaction.id).toBe(TX_ID);
    const houseEntry = await fresh().findOneOrFail(LedgerEntryRecord, LEDGER_HOUSE_ID);
    expect(houseEntry.houseAccount?.id).toBe(HOUSE_ID);
    expect(houseEntry.wallet).toBeNull();
    expect(houseEntry.balanceBefore).toBeNull();
    expect(houseEntry.walletVersion).toBeNull();
  });

  it('round-trips idempotency records with a composite key and jsonb body', async () => {
    await seedTransactions();
    const em = fresh();
    em.persist(
      new IdempotencyRecordRecord({
        providerId: 'provider-a',
        idempotencyKey: 'key-1',
        payloadHash: HASH,
        transaction: ref(WagerTransactionRecord, TX_ID),
        httpStatus: 200,
        responseBody: { status: 'PROCESSED', nested: { amount: '10.00' } },
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    await em.flush();
    const found = await fresh().findOneOrFail(IdempotencyRecordRecord, {
      providerId: 'provider-a',
      idempotencyKey: 'key-1',
    });
    expect(found.httpStatus).toBe(200);
    expect(found.transaction?.id).toBe(TX_ID);
    expect(found.responseBody).toEqual({ status: 'PROCESSED', nested: { amount: '10.00' } });
  });

  it('round-trips inbox messages', async () => {
    const em = fresh();
    em.persist(
      new InboxMessageRecord({
        consumerName: 'wager-transactions-consumer',
        messageId: 'm-1',
        payloadHash: HASH,
        receivedAt: NOW,
        processedAt: null,
      }),
    );
    await em.flush();
    const found = await fresh().findOneOrFail(InboxMessageRecord, {
      consumerName: 'wager-transactions-consumer',
      messageId: 'm-1',
    });
    expect(found.payloadHash).toBe(HASH);
    expect(found.processedAt).toBeNull();
  });

  it('round-trips outbox messages applying the counter defaults', async () => {
    const em = fresh();
    em.persist(
      new OutboxMessageRecord({
        id: OUTBOX_ID,
        aggregateId: TX_ID,
        eventType: 'WagerTransactionProcessed',
        payload: { version: 1, list: [1, 2] },
        occurredAt: NOW,
        attempts: 3,
        permanentFailures: 1,
        nextAttemptAt: LATER,
        lockedUntil: null,
        lockedBy: null,
        publishedAt: null,
        parkedAt: null,
        lastErrorCode: 'X',
      }),
    );
    await em.flush();
    const found = await fresh().findOneOrFail(OutboxMessageRecord, OUTBOX_ID);
    expect(found.payload).toEqual({ version: 1, list: [1, 2] });
    expect(found.attempts).toBe(3);
    expect(found.permanentFailures).toBe(1);
    expect(found.nextAttemptAt.getTime()).toBe(LATER.getTime());
    expect(found.lastErrorCode).toBe('X');
  });

  it('round-trips pending reference retries keyed by transaction', async () => {
    await seedTransactions();
    const em = fresh();
    em.persist(
      new PendingReferenceRetryRecord({
        transaction: ref(WagerTransactionRecord, TX_ID),
        attempts: 2,
        consecutiveErrors: 1,
        nextAttemptAt: LATER,
        deadlineAt: LATER,
        lockedUntil: null,
        lockedBy: null,
        resolvedAt: null,
        createdAt: NOW,
      }),
    );
    await em.flush();
    const found = await fresh().findOneOrFail(PendingReferenceRetryRecord, {
      transaction: TX_ID,
    });
    expect(found.transaction.id).toBe(TX_ID);
    expect(found.attempts).toBe(2);
    expect(found.consecutiveErrors).toBe(1);
  });

  it('round-trips the seeded scheduled job after an update', async () => {
    const em = fresh();
    const job = await em.findOneOrFail(ScheduledJobRecord, { name: 'global-reconciliation' });
    expect(job.lastRunAt).toBeNull();
    job.lockedBy = 'instance-1';
    job.lockedUntil = LATER;
    job.lastRunAt = NOW;
    await em.flush();
    const found = await fresh().findOneOrFail(ScheduledJobRecord, {
      name: 'global-reconciliation',
    });
    expect(found.lockedBy).toBe('instance-1');
    expect(found.lockedUntil?.getTime()).toBe(LATER.getTime());
    expect(found.lastRunAt?.getTime()).toBe(NOW.getTime());
  });

  it('round-trips reconciliation runs with wide numerics and jsonb details', async () => {
    const em = fresh();
    em.persist(
      new ReconciliationRunRecord({
        id: RUN_ID,
        scope: 'WALLET',
        walletId: WALLET_ID,
        consistent: false,
        checkedEntries: 4,
        storedAmount: '100.00',
        calculatedAmount: '90.00',
        differenceAmount: '10.00',
        currency: 'BRL',
        firstDivergentVersion: 2,
        details: { divergences: [{ version: 2 }] },
        startedAt: NOW,
        finishedAt: LATER,
      }),
    );
    await em.flush();
    const found = await fresh().findOneOrFail(ReconciliationRunRecord, RUN_ID);
    expect(found.consistent).toBe(false);
    expect(found.storedAmount).toBe('100.00');
    expect(found.differenceAmount).toBe('10.00');
    expect(found.firstDivergentVersion).toBe(2);
    expect(found.details).toEqual({ divergences: [{ version: 2 }] });
    expect(found.finishedAt.getTime()).toBe(LATER.getTime());
  });
});
