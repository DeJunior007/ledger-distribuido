import { EntitySchema } from '@mikro-orm/core';
import { WalletRecord } from '../records/wallets.record';
import { ExactDecimalType } from '../types/exact-decimal.type';

export const WalletEntitySchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', fieldName: 'id', primary: true },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    currency: { type: 'character', length: 3, fieldName: 'currency' },
    balance: {
      type: ExactDecimalType,
      precision: 20,
      scale: 2,
      fieldName: 'balance',
    },
    version: { type: 'integer', fieldName: 'version', version: true, default: 1 },
    createdAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'created_at' },
    updatedAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'updated_at' },
  },
});
