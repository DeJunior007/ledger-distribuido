import type { Ref } from '@mikro-orm/core';
import type { WalletRecord } from './wallets.record';

export interface WagerTransactionRecordProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  wallet: Ref<WalletRecord>;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransaction: Ref<WagerTransactionRecord> | null;
  status: string;
  failureCode: string | null;
  balanceSnapshotAmount: string | null;
  balanceSnapshotCurrency: string | null;
  correlationId: string;
  createdAt: Date;
  processedAt: Date | null;
  updatedAt: Date;
}

export class WagerTransactionRecord {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  wallet: Ref<WalletRecord>;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransaction: Ref<WagerTransactionRecord> | null;
  status: string;
  failureCode: string | null;
  balanceSnapshotAmount: string | null;
  balanceSnapshotCurrency: string | null;
  correlationId: string;
  createdAt: Date;
  processedAt: Date | null;
  updatedAt: Date;

  constructor(props: WagerTransactionRecordProps) {
    this.id = props.id;
    this.providerId = props.providerId;
    this.externalTransactionId = props.externalTransactionId;
    this.idempotencyKey = props.idempotencyKey;
    this.payloadHash = props.payloadHash;
    this.wallet = props.wallet;
    this.playerId = props.playerId;
    this.roundId = props.roundId;
    this.gameId = props.gameId;
    this.kind = props.kind;
    this.amount = props.amount;
    this.currency = props.currency;
    this.referenceExternalTransactionId = props.referenceExternalTransactionId;
    this.referenceTransaction = props.referenceTransaction;
    this.status = props.status;
    this.failureCode = props.failureCode;
    this.balanceSnapshotAmount = props.balanceSnapshotAmount;
    this.balanceSnapshotCurrency = props.balanceSnapshotCurrency;
    this.correlationId = props.correlationId;
    this.createdAt = props.createdAt;
    this.processedAt = props.processedAt;
    this.updatedAt = props.updatedAt;
  }
}
