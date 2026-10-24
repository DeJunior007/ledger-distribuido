import { InboxMessage } from '@domain/messaging/inbox-message';
import { InboxMessageRecord } from '../records/inbox-messages.record';

export function toDomain(record: InboxMessageRecord): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: record.consumerName,
    messageId: record.messageId,
    payloadHash: record.payloadHash,
    receivedAt: record.receivedAt,
    processedAt: record.processedAt ?? undefined,
  });
}

export function toRecord(message: InboxMessage, existing?: InboxMessageRecord): InboxMessageRecord {
  const state = message.toState();
  if (existing !== undefined) {
    existing.processedAt = state.processedAt ?? null;
    return existing;
  }
  return new InboxMessageRecord({
    consumerName: state.consumerName,
    messageId: state.messageId,
    payloadHash: state.payloadHash,
    receivedAt: state.receivedAt,
    processedAt: state.processedAt ?? null,
  });
}
