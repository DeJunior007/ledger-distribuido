import { toCurrencyCode } from '@domain/shared/currency';
import { Money } from '@domain/shared/money';
import { Wallet } from '@domain/wallet/wallet';
import { WalletRecord } from '../records/wallets.record';

export function toDomain(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: toCurrencyCode(record.currency),
    balance: Money.fromPersistence(record.balance, record.currency),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function toRecord(wallet: Wallet, existing?: WalletRecord): WalletRecord {
  const state = wallet.toState();
  if (existing !== undefined) {
    existing.balance = state.balance.toJSON().amount;
    existing.updatedAt = state.updatedAt;
    return existing;
  }
  return new WalletRecord({
    id: state.id,
    playerId: state.playerId,
    currency: state.currency,
    balance: state.balance.toJSON().amount,
    version: state.version,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  });
}
