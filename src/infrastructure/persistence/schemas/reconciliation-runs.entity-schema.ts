import { EntitySchema } from '@mikro-orm/core';
import { ReconciliationRunRecord } from '../records/reconciliation-runs.record';

export const ReconciliationRunEntitySchema = new EntitySchema<ReconciliationRunRecord>({
  class: ReconciliationRunRecord,
  tableName: 'reconciliation_runs',
  properties: {
    id: { type: 'uuid', fieldName: 'id', primary: true },
    scope: { type: 'text', fieldName: 'scope' },
    walletId: { type: 'uuid', fieldName: 'wallet_id', nullable: true },
    consistent: { type: 'boolean', fieldName: 'consistent' },
    checkedEntries: { type: 'integer', fieldName: 'checked_entries' },
    storedAmount: {
      type: 'decimal',
      precision: 32,
      scale: 2,
      runtimeType: 'string',
      fieldName: 'stored_amount',
      nullable: true,
    },
    calculatedAmount: {
      type: 'decimal',
      precision: 32,
      scale: 2,
      runtimeType: 'string',
      fieldName: 'calculated_amount',
      nullable: true,
    },
    differenceAmount: {
      type: 'decimal',
      precision: 32,
      scale: 2,
      runtimeType: 'string',
      fieldName: 'difference_amount',
      nullable: true,
    },
    currency: { type: 'character', length: 3, fieldName: 'currency', nullable: true },
    firstDivergentVersion: {
      type: 'integer',
      fieldName: 'first_divergent_version',
      nullable: true,
    },
    details: { type: 'json', columnType: 'jsonb', fieldName: 'details' },
    startedAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'started_at' },
    finishedAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'finished_at' },
  },
});
