import { EntitySchema } from '@mikro-orm/core';
import { IdempotencyRecordRecord } from '../records/idempotency-records.record';
import { WagerTransactionRecord } from '../records/wager-transactions.record';

export const IdempotencyRecordEntitySchema = new EntitySchema<IdempotencyRecordRecord>({
  class: IdempotencyRecordRecord,
  tableName: 'idempotency_records',
  properties: {
    providerId: { type: 'text', fieldName: 'provider_id', primary: true },
    idempotencyKey: { type: 'text', fieldName: 'idempotency_key', primary: true },
    payloadHash: { type: 'character', length: 64, fieldName: 'payload_hash' },
    transaction: {
      kind: 'm:1',
      entity: () => WagerTransactionRecord,
      ref: true,
      fieldName: 'transaction_id',
      nullable: true,
    },
    httpStatus: { type: 'smallint', fieldName: 'http_status' },
    responseBody: { type: 'json', columnType: 'jsonb', fieldName: 'response_body' },
    createdAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'created_at' },
    updatedAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'updated_at' },
  },
});
