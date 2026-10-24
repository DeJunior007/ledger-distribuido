import { EntitySchema } from '@mikro-orm/core';
import { WagerTransactionRecord } from '../records/wager-transactions.record';
import { WalletRecord } from '../records/wallets.record';

export const WagerTransactionEntitySchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', fieldName: 'id', primary: true },
    providerId: { type: 'text', fieldName: 'provider_id' },
    externalTransactionId: { type: 'text', fieldName: 'external_transaction_id' },
    idempotencyKey: { type: 'text', fieldName: 'idempotency_key' },
    payloadHash: { type: 'character', length: 64, fieldName: 'payload_hash' },
    wallet: { kind: 'm:1', entity: () => WalletRecord, ref: true, fieldName: 'wallet_id' },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    roundId: { type: 'text', fieldName: 'round_id' },
    gameId: { type: 'text', fieldName: 'game_id' },
    kind: { type: 'text', fieldName: 'kind' },
    amount: {
      type: 'decimal',
      precision: 20,
      scale: 2,
      runtimeType: 'string',
      fieldName: 'amount',
    },
    currency: { type: 'character', length: 3, fieldName: 'currency' },
    referenceExternalTransactionId: {
      type: 'text',
      fieldName: 'reference_external_transaction_id',
      nullable: true,
    },
    referenceTransaction: {
      kind: 'm:1',
      entity: () => WagerTransactionRecord,
      ref: true,
      fieldName: 'reference_transaction_id',
      nullable: true,
    },
    status: { type: 'text', fieldName: 'status' },
    failureCode: { type: 'text', fieldName: 'failure_code', nullable: true },
    balanceSnapshotAmount: {
      type: 'decimal',
      precision: 20,
      scale: 2,
      runtimeType: 'string',
      fieldName: 'balance_snapshot_amount',
      nullable: true,
    },
    balanceSnapshotCurrency: {
      type: 'character',
      length: 3,
      fieldName: 'balance_snapshot_currency',
      nullable: true,
    },
    correlationId: { type: 'text', fieldName: 'correlation_id' },
    createdAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'created_at' },
    processedAt: {
      type: 'datetime',
      columnType: 'timestamptz',
      fieldName: 'processed_at',
      nullable: true,
    },
    updatedAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'updated_at' },
  },
});
