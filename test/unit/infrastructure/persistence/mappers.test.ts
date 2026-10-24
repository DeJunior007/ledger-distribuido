import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { IdempotencyRecord } from '@domain/idempotency/idempotency-record';
import { InboxMessage } from '@domain/messaging/inbox-message';
import { OutboxMessage } from '@domain/messaging/outbox-message';
import { FailureCode } from '@domain/shared/failure-code';
import { Money } from '@domain/shared/money';
import { WagerTransaction } from '@domain/wagering/wager-transaction';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '@domain/wagering/wager-transaction-status';
import { HouseAccount, HouseAccountPurpose } from '@domain/wallet/house-account';
import { HouseLedgerEntry } from '@domain/wallet/house-ledger-entry';
import { LedgerDirection } from '@domain/wallet/ledger-direction';
import { Wallet } from '@domain/wallet/wallet';
import { WalletLedgerEntry } from '@domain/wallet/wallet-ledger-entry';
import * as houseAccountMapper from '@infrastructure/persistence/mappers/house-account.mapper';
import * as idempotencyMapper from '@infrastructure/persistence/mappers/idempotency-record.mapper';
import * as inboxMapper from '@infrastructure/persistence/mappers/inbox-message.mapper';
import * as ledgerMapper from '@infrastructure/persistence/mappers/ledger-entry.mapper';
import * as outboxMapper from '@infrastructure/persistence/mappers/outbox-message.mapper';
import * as transactionMapper from '@infrastructure/persistence/mappers/wager-transaction.mapper';
import * as walletMapper from '@infrastructure/persistence/mappers/wallet.mapper';
import { IdempotencyRecordRecord } from '@infrastructure/persistence/records/idempotency-records.record';
import { OutboxMessageRecord } from '@infrastructure/persistence/records/outbox-messages.record';
import { ENTITY_SCHEMAS } from '@infrastructure/persistence/schemas';

const WALLET_ID = '0197a000-0000-7000-8000-000000000001';
const PLAYER_ID = '0197a000-0000-7000-8000-000000000002';
const TX_ID = '0197a000-0000-7000-8000-000000000003';
const REF_TX_ID = '0197a000-0000-7000-8000-000000000004';
const HOUSE_ID = '0197a000-0000-7000-8000-000000000005';
const ENTRY_ID = '0197a000-0000-7000-8000-000000000006';
const HOUSE_ENTRY_ID = '0197a000-0000-7000-8000-000000000007';
const BIG = '999999999999999999.99';
const NOW = new Date('2026-10-24T12:00:00.000Z');
const LATER = new Date('2026-10-24T12:05:00.000Z');

let orm: MikroORM;

beforeAll(async () => {
  orm = await MikroORM.init({
    driver: PostgreSqlDriver,
    entities: [...ENTITY_SCHEMAS],
    dbName: 'mapper_unit',
    connect: false,
  });
});

afterAll(async () => {
  await orm.close();
});

function wagerProps(kind: WagerTransactionKind, reference: string | undefined) {
  return {
    id: TX_ID,
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'key-1',
    payloadHash: 'hash-1',
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: Money.from({ amount: '10.00', currency: 'BRL' }),
    referenceExternalTransactionId: reference,
    correlationId: 'corr-1',
    now: NOW,
  };
}

describe('wallet mapper', () => {
  it('round-trips an 18 digit balance and keeps the version', () => {
    const wallet = Wallet.rehydrate({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      currency: Money.from({ amount: BIG, currency: 'BRL' }).currency,
      balance: Money.from({ amount: BIG, currency: 'BRL' }),
      version: 7,
      createdAt: NOW,
      updatedAt: LATER,
    });
    const record = walletMapper.toRecord(wallet);
    expect(record.balance).toBe(BIG);
    expect(record.version).toBe(7);
    expect(walletMapper.toDomain(record).toState()).toEqual(wallet.toState());
  });

  it('sets version 1 on a freshly opened wallet record', () => {
    const { wallet } = Wallet.open({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      initialBalance: Money.zero('BRL'),
      openingTransactionId: TX_ID,
      fundingAccountId: HOUSE_ID,
      walletEntryId: ENTRY_ID,
      houseEntryId: HOUSE_ENTRY_ID,
      now: NOW,
    });
    expect(walletMapper.toRecord(wallet).version).toBe(1);
  });

  it('does not write version when updating an existing record', () => {
    const wallet = Wallet.rehydrate({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      currency: Money.zero('BRL').currency,
      balance: Money.from({ amount: '5.00', currency: 'BRL' }),
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const existing = walletMapper.toRecord(wallet);
    existing.version = 4;
    const posting = wallet.credit({
      transactionId: TX_ID,
      money: Money.from({ amount: '2.50', currency: 'BRL' }),
      houseAccountId: HOUSE_ID,
      walletEntryId: ENTRY_ID,
      houseEntryId: HOUSE_ENTRY_ID,
      now: LATER,
    });
    expect(posting.walletEntry.walletVersion).toBe(2);
    const updated = walletMapper.toRecord(wallet, existing);
    expect(updated).toBe(existing);
    expect(updated.version).toBe(4);
    expect(updated.balance).toBe('7.50');
    expect(updated.updatedAt).toEqual(LATER);
  });
});

describe('house account mapper', () => {
  it('round-trips', () => {
    const account = HouseAccount.create({
      id: HOUSE_ID,
      currency: Money.zero('BRL').currency,
      purpose: HouseAccountPurpose.Funding,
      createdAt: NOW,
    });
    const back = houseAccountMapper.toDomain(houseAccountMapper.toRecord(account));
    expect(back).toEqual(account);
  });
});

describe('wager transaction mapper', () => {
  it('round-trips a pending transaction with undefined fields', () => {
    const tx = WagerTransaction.create(wagerProps(WagerTransactionKind.Bet, undefined));
    const record = transactionMapper.toRecord(tx);
    expect(record.referenceExternalTransactionId).toBeNull();
    expect(record.referenceTransaction).toBeNull();
    expect(record.failureCode).toBeNull();
    expect(record.balanceSnapshotAmount).toBeNull();
    expect(record.processedAt).toBeNull();
    expect(record.wallet.id).toBe(WALLET_ID);
    expect(transactionMapper.toDomain(record).toState()).toEqual(tx.toState());
  });

  it('keeps a balance snapshot in a different currency than the transaction', () => {
    const tx = WagerTransaction.create(wagerProps(WagerTransactionKind.Bet, undefined));
    tx.reject({
      failureCode: FailureCode.CurrencyMismatch,
      referenceTransactionId: undefined,
      balanceSnapshot: Money.from({ amount: BIG, currency: 'USD' }),
      at: LATER,
    });
    const record = transactionMapper.toRecord(tx);
    expect(record.currency).toBe('BRL');
    expect(record.balanceSnapshotAmount).toBe(BIG);
    expect(record.balanceSnapshotCurrency).toBe('USD');
    const back = transactionMapper.toDomain(record).toState();
    expect(back).toEqual(tx.toState());
    expect(back.balanceSnapshot?.currency).toBe(Money.zero('USD').currency);
    expect(back.status).toBe(WagerTransactionStatus.Rejected);
  });

  it('round-trips a processed reference and updates an existing record', () => {
    const tx = WagerTransaction.create(wagerProps(WagerTransactionKind.Refund, 'ext-0'));
    const existing = transactionMapper.toRecord(tx);
    tx.markProcessed({
      referenceTransactionId: REF_TX_ID,
      balanceSnapshot: Money.from({ amount: '3.00', currency: 'BRL' }),
      at: LATER,
    });
    const updated = transactionMapper.toRecord(tx, existing);
    expect(updated).toBe(existing);
    expect(updated.referenceTransaction?.id).toBe(REF_TX_ID);
    expect(updated.status).toBe('PROCESSED');
    expect(transactionMapper.toDomain(updated).toState()).toEqual(tx.toState());
  });
});

describe('ledger entry mapper', () => {
  it('maps a wallet entry to a WALLET record and back to WalletLedgerEntry', () => {
    const entry = WalletLedgerEntry.create({
      id: ENTRY_ID,
      walletId: WALLET_ID,
      transactionId: TX_ID,
      direction: LedgerDirection.Credit,
      money: Money.from({ amount: '1.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: BIG, currency: 'BRL' }).subtract(
        Money.from({ amount: '1.00', currency: 'BRL' }),
      ),
      balanceAfter: Money.from({ amount: BIG, currency: 'BRL' }),
      walletVersion: 9,
      createdAt: NOW,
    });
    const record = ledgerMapper.toRecord(entry);
    expect(record.accountKind).toBe('WALLET');
    expect(record.houseAccount).toBeNull();
    expect(record.balanceAfter).toBe(BIG);
    const back = ledgerMapper.toDomain(record);
    expect(back).toBeInstanceOf(WalletLedgerEntry);
    expect(back).toEqual(entry);
  });

  it('maps a house entry to a HOUSE record and back to HouseLedgerEntry', () => {
    const entry = HouseLedgerEntry.create({
      id: HOUSE_ENTRY_ID,
      houseAccountId: HOUSE_ID,
      transactionId: TX_ID,
      direction: LedgerDirection.Debit,
      money: Money.from({ amount: '1.00', currency: 'BRL' }),
      createdAt: NOW,
    });
    const record = ledgerMapper.toRecord(entry);
    expect(record.accountKind).toBe('HOUSE');
    expect(record.wallet).toBeNull();
    expect(record.balanceBefore).toBeNull();
    expect(record.walletVersion).toBeNull();
    const back = ledgerMapper.toDomain(record);
    expect(back).toBeInstanceOf(HouseLedgerEntry);
    expect(back).toEqual(entry);
  });
});

describe('idempotency record mapper', () => {
  const body = {
    transactionId: TX_ID,
    status: 'PROCESSED' as const,
    kind: WagerTransactionKind.Bet,
    balance: { amount: '1.00', currency: 'BRL' },
    idempotentReplay: false,
  };

  it('round-trips and resolves an existing pending record', () => {
    const idem = IdempotencyRecord.create({
      providerId: 'provider-a',
      idempotencyKey: 'key-1',
      payloadHash: 'hash-1',
      transactionId: undefined,
      httpStatus: 202,
      responseBody: { ...body, status: 'PENDING_REFERENCE' },
      createdAt: NOW,
    });
    const record = idempotencyMapper.toRecord(idem);
    expect(record.transaction).toBeNull();
    expect(idempotencyMapper.toDomain(record).toState()).toEqual(idem.toState());
    idem.resolve({ httpStatus: 200, responseBody: body, at: LATER });
    const updated = idempotencyMapper.toRecord(idem, record);
    expect(updated).toBe(record);
    expect(updated.httpStatus).toBe(200);
    expect(idempotencyMapper.toDomain(updated).toState()).toEqual(idem.toState());
  });

  it('rejects a corrupted stored body', () => {
    const record = new IdempotencyRecordRecord({
      providerId: 'p',
      idempotencyKey: 'k',
      payloadHash: 'h',
      transaction: null,
      httpStatus: 200,
      responseBody: 'nope',
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(() => idempotencyMapper.toDomain(record)).toThrow();
  });
});

describe('inbox message mapper', () => {
  it('round-trips and marks processed on an existing record', () => {
    const inbox = InboxMessage.receive({
      consumerName: 'wager-transactions-consumer',
      messageId: 'm-1',
      payloadHash: 'hash',
      now: NOW,
    });
    const record = inboxMapper.toRecord(inbox);
    expect(record.processedAt).toBeNull();
    expect(inboxMapper.toDomain(record).toState()).toEqual(inbox.toState());
    inbox.markProcessed(LATER);
    const updated = inboxMapper.toRecord(inbox, record);
    expect(updated.processedAt).toEqual(LATER);
    expect(inboxMapper.toDomain(updated).toState()).toEqual(inbox.toState());
  });
});

describe('outbox message mapper', () => {
  it('round-trips and applies a retry on an existing record', () => {
    const outbox = OutboxMessage.rehydrate({
      id: TX_ID,
      aggregateId: WALLET_ID,
      eventType: 'WalletBalanceChanged',
      payload: { a: 1, nested: { b: 'x' } },
      occurredAt: NOW,
      attempts: 0,
      permanentFailures: 0,
      nextAttemptAt: NOW,
      lockedUntil: undefined,
      lockedBy: undefined,
      publishedAt: undefined,
      parkedAt: undefined,
      lastErrorCode: undefined,
    });
    const record = outboxMapper.toRecord(outbox);
    expect(record.lockedBy).toBeNull();
    expect(outboxMapper.toDomain(record).toState()).toEqual(outbox.toState());
    outbox.scheduleRetry({ now: LATER, kind: 'TRANSIENT', errorCode: 'E', jitterRatio: 0 });
    const updated = outboxMapper.toRecord(outbox, record);
    expect(updated).toBe(record);
    expect(updated.attempts).toBe(1);
    expect(outboxMapper.toDomain(updated).toState()).toEqual(outbox.toState());
  });

  it('rejects a non object payload', () => {
    const record = new OutboxMessageRecord({
      id: TX_ID,
      aggregateId: WALLET_ID,
      eventType: 'x',
      payload: [1],
      occurredAt: NOW,
      attempts: 0,
      permanentFailures: 0,
      nextAttemptAt: NOW,
      lockedUntil: null,
      lockedBy: null,
      publishedAt: null,
      parkedAt: null,
      lastErrorCode: null,
    });
    expect(() => outboxMapper.toDomain(record)).toThrow();
  });
});
