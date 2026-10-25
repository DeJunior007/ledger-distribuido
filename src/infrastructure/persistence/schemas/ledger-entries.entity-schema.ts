import { EntitySchema } from '@mikro-orm/core';
import { HouseAccountRecord } from '../records/house-accounts.record';
import { LedgerEntryRecord } from '../records/ledger-entries.record';
import { WagerTransactionRecord } from '../records/wager-transactions.record';
import { WalletRecord } from '../records/wallets.record';
import { ExactDecimalType } from '../types/exact-decimal.type';

export const LedgerEntryEntitySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: 'ledger_entries',
  properties: {
    id: { type: 'uuid', fieldName: 'id', primary: true },
    transaction: {
      kind: 'm:1',
      entity: () => WagerTransactionRecord,
      ref: true,
      fieldName: 'transaction_id',
    },
    accountKind: { type: 'text', fieldName: 'account_kind' },
    wallet: {
      kind: 'm:1',
      entity: () => WalletRecord,
      ref: true,
      fieldName: 'wallet_id',
      nullable: true,
    },
    houseAccount: {
      kind: 'm:1',
      entity: () => HouseAccountRecord,
      ref: true,
      fieldName: 'house_account_id',
      nullable: true,
    },
    direction: { type: 'text', fieldName: 'direction' },
    amount: {
      type: ExactDecimalType,
      precision: 20,
      scale: 2,
      fieldName: 'amount',
    },
    currency: { type: 'character', length: 3, fieldName: 'currency' },
    balanceBefore: {
      type: ExactDecimalType,
      precision: 20,
      scale: 2,
      fieldName: 'balance_before',
      nullable: true,
    },
    balanceAfter: {
      type: ExactDecimalType,
      precision: 20,
      scale: 2,
      fieldName: 'balance_after',
      nullable: true,
    },
    walletVersion: { type: 'integer', fieldName: 'wallet_version', nullable: true },
    createdAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'created_at' },
  },
});
