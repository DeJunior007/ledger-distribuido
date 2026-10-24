import { EntitySchema } from '@mikro-orm/core';
import { InboxMessageRecord } from '../records/inbox-messages.record';

export const InboxMessageEntitySchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'text', fieldName: 'consumer_name', primary: true },
    messageId: { type: 'text', fieldName: 'message_id', primary: true },
    payloadHash: { type: 'character', length: 64, fieldName: 'payload_hash' },
    receivedAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'received_at' },
    processedAt: {
      type: 'datetime',
      columnType: 'timestamptz',
      fieldName: 'processed_at',
      nullable: true,
    },
  },
});
