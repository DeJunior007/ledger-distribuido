import { ref } from '@mikro-orm/core';
import { FailureCode } from '@domain/shared/failure-code';
import { Money } from '@domain/shared/money';
import { WagerTransaction } from '@domain/wagering/wager-transaction';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '@domain/wagering/wager-transaction-status';
import { WagerTransactionRecord } from '../records/wager-transactions.record';
import { WalletRecord } from '../records/wallets.record';
import { parseEnum } from './persisted-values.mapper';

function snapshotOf(record: WagerTransactionRecord): Money | undefined {
  if (record.balanceSnapshotAmount === null || record.balanceSnapshotCurrency === null) {
    return undefined;
  }
  return Money.fromPersistence(record.balanceSnapshotAmount, record.balanceSnapshotCurrency);
}

export function toDomain(record: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.wallet.id,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: parseEnum(WagerTransactionKind, record.kind),
    money: Money.fromPersistence(record.amount, record.currency),
    referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
    referenceTransactionId: record.referenceTransaction?.id ?? undefined,
    status: parseEnum(WagerTransactionStatus, record.status),
    failureCode:
      record.failureCode === null ? undefined : parseEnum(FailureCode, record.failureCode),
    balanceSnapshot: snapshotOf(record),
    correlationId: record.correlationId,
    createdAt: record.createdAt,
    processedAt: record.processedAt ?? undefined,
    updatedAt: record.updatedAt,
  });
}

export function toRecord(
  transaction: WagerTransaction,
  existing?: WagerTransactionRecord,
): WagerTransactionRecord {
  const state = transaction.toState();
  const referenceTransaction =
    state.referenceTransactionId === undefined
      ? null
      : ref(WagerTransactionRecord, state.referenceTransactionId);
  const snapshot = state.balanceSnapshot?.toJSON();
  if (existing !== undefined) {
    existing.status = state.status;
    existing.failureCode = state.failureCode ?? null;
    existing.balanceSnapshotAmount = snapshot?.amount ?? null;
    existing.balanceSnapshotCurrency = snapshot?.currency ?? null;
    existing.processedAt = state.processedAt ?? null;
    existing.updatedAt = state.updatedAt;
    if (existing.referenceTransaction?.id !== state.referenceTransactionId) {
      existing.referenceTransaction = referenceTransaction;
    }
    return existing;
  }
  const money = state.money.toJSON();
  return new WagerTransactionRecord({
    id: state.id,
    providerId: state.providerId,
    externalTransactionId: state.externalTransactionId,
    idempotencyKey: state.idempotencyKey,
    payloadHash: state.payloadHash,
    wallet: ref(WalletRecord, state.walletId),
    playerId: state.playerId,
    roundId: state.roundId,
    gameId: state.gameId,
    kind: state.kind,
    amount: money.amount,
    currency: money.currency,
    referenceExternalTransactionId: state.referenceExternalTransactionId ?? null,
    referenceTransaction,
    status: state.status,
    failureCode: state.failureCode ?? null,
    balanceSnapshotAmount: snapshot?.amount ?? null,
    balanceSnapshotCurrency: snapshot?.currency ?? null,
    correlationId: state.correlationId,
    createdAt: state.createdAt,
    processedAt: state.processedAt ?? null,
    updatedAt: state.updatedAt,
  });
}
