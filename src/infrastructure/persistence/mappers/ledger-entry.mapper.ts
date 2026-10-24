import { ref } from '@mikro-orm/core';
import { Money } from '@domain/shared/money';
import { HouseLedgerEntry } from '@domain/wallet/house-ledger-entry';
import { LedgerDirection } from '@domain/wallet/ledger-direction';
import { WalletLedgerEntry } from '@domain/wallet/wallet-ledger-entry';
import { HouseAccountRecord } from '../records/house-accounts.record';
import { LedgerEntryRecord } from '../records/ledger-entries.record';
import { WagerTransactionRecord } from '../records/wager-transactions.record';
import { WalletRecord } from '../records/wallets.record';
import { corruptedRow, parseEnum } from './persisted-values.mapper';

export enum LedgerAccountKind {
  Wallet = 'WALLET',
  House = 'HOUSE',
}

export type LedgerEntry = WalletLedgerEntry | HouseLedgerEntry;

function toWalletEntry(record: LedgerEntryRecord): WalletLedgerEntry {
  if (
    record.wallet === null ||
    record.balanceBefore === null ||
    record.balanceAfter === null ||
    record.walletVersion === null
  ) {
    throw corruptedRow();
  }
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.wallet.id,
    transactionId: record.transaction.id,
    direction: parseEnum(LedgerDirection, record.direction),
    money: Money.fromPersistence(record.amount, record.currency),
    balanceBefore: Money.fromPersistence(record.balanceBefore, record.currency),
    balanceAfter: Money.fromPersistence(record.balanceAfter, record.currency),
    walletVersion: record.walletVersion,
    createdAt: record.createdAt,
  });
}

function toHouseEntry(record: LedgerEntryRecord): HouseLedgerEntry {
  if (record.houseAccount === null) {
    throw corruptedRow();
  }
  return HouseLedgerEntry.rehydrate({
    id: record.id,
    houseAccountId: record.houseAccount.id,
    transactionId: record.transaction.id,
    direction: parseEnum(LedgerDirection, record.direction),
    money: Money.fromPersistence(record.amount, record.currency),
    createdAt: record.createdAt,
  });
}

export function toDomain(record: LedgerEntryRecord): LedgerEntry {
  switch (parseEnum(LedgerAccountKind, record.accountKind)) {
    case LedgerAccountKind.Wallet:
      return toWalletEntry(record);
    case LedgerAccountKind.House:
      return toHouseEntry(record);
  }
}

export function toRecord(entry: LedgerEntry): LedgerEntryRecord {
  const money = entry.money.toJSON();
  if (entry instanceof WalletLedgerEntry) {
    return new LedgerEntryRecord({
      id: entry.id,
      transaction: ref(WagerTransactionRecord, entry.transactionId),
      accountKind: LedgerAccountKind.Wallet,
      wallet: ref(WalletRecord, entry.walletId),
      houseAccount: null,
      direction: entry.direction,
      amount: money.amount,
      currency: money.currency,
      balanceBefore: entry.balanceBefore.toJSON().amount,
      balanceAfter: entry.balanceAfter.toJSON().amount,
      walletVersion: entry.walletVersion,
      createdAt: entry.createdAt,
    });
  }
  return new LedgerEntryRecord({
    id: entry.id,
    transaction: ref(WagerTransactionRecord, entry.transactionId),
    accountKind: LedgerAccountKind.House,
    wallet: null,
    houseAccount: ref(HouseAccountRecord, entry.houseAccountId),
    direction: entry.direction,
    amount: money.amount,
    currency: money.currency,
    balanceBefore: null,
    balanceAfter: null,
    walletVersion: null,
    createdAt: entry.createdAt,
  });
}
