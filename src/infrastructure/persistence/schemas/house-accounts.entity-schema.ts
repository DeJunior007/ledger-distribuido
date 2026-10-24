import { EntitySchema } from '@mikro-orm/core';
import { HouseAccountRecord } from '../records/house-accounts.record';

export const HouseAccountEntitySchema = new EntitySchema<HouseAccountRecord>({
  class: HouseAccountRecord,
  tableName: 'house_accounts',
  properties: {
    id: { type: 'uuid', fieldName: 'id', primary: true },
    currency: { type: 'character', length: 3, fieldName: 'currency' },
    purpose: { type: 'text', fieldName: 'purpose' },
    createdAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'created_at' },
  },
});
