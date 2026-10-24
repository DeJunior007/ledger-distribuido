import type { Ref } from '@mikro-orm/core';
import type { HouseAccountRecord } from './house-accounts.record';
import type { WagerTransactionRecord } from './wager-transactions.record';
import type { WalletRecord } from './wallets.record';

export interface LedgerEntryRecordProps {
  id: string;
  transaction: Ref<WagerTransactionRecord>;
  accountKind: string;
  wallet: Ref<WalletRecord> | null;
  houseAccount: Ref<HouseAccountRecord> | null;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string | null;
  balanceAfter: string | null;
  walletVersion: number | null;
  createdAt: Date;
}

export class LedgerEntryRecord {
  id: string;
  transaction: Ref<WagerTransactionRecord>;
  accountKind: string;
  wallet: Ref<WalletRecord> | null;
  houseAccount: Ref<HouseAccountRecord> | null;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string | null;
  balanceAfter: string | null;
  walletVersion: number | null;
  createdAt: Date;

  constructor(props: LedgerEntryRecordProps) {
    this.id = props.id;
    this.transaction = props.transaction;
    this.accountKind = props.accountKind;
    this.wallet = props.wallet;
    this.houseAccount = props.houseAccount;
    this.direction = props.direction;
    this.amount = props.amount;
    this.currency = props.currency;
    this.balanceBefore = props.balanceBefore;
    this.balanceAfter = props.balanceAfter;
    this.walletVersion = props.walletVersion;
    this.createdAt = props.createdAt;
  }
}
