import { describe, expect, it } from 'bun:test';
import { InboxMessage } from '@domain/messaging/inbox-message';
import { InvalidInboxTransitionError } from '@domain/messaging/errors/invalid-inbox-transition.error';

const receivedAt = new Date('2026-01-01T00:00:00.000Z');
const processedAt = new Date('2026-01-01T00:00:01.000Z');

function receive(): InboxMessage {
  return InboxMessage.receive({
    consumerName: 'wager-transactions-consumer',
    messageId: 'msg-1',
    payloadHash: 'hash-1',
    now: receivedAt,
  });
}

describe('InboxMessage', () => {
  it('receives a message as unprocessed', () => {
    const message = receive();
    expect(message.consumerName).toBe('wager-transactions-consumer');
    expect(message.messageId).toBe('msg-1');
    expect(message.receivedAt).toEqual(receivedAt);
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
  });

  it('marks a message as processed', () => {
    const message = receive();
    message.markProcessed(processedAt);
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(processedAt);
  });

  it('throws when marking processed twice', () => {
    const message = receive();
    message.markProcessed(processedAt);
    expect(() => {
      message.markProcessed(processedAt);
    }).toThrow(InvalidInboxTransitionError);
  });

  it('matches only the same payload hash', () => {
    const message = receive();
    expect(message.matchesPayload('hash-1')).toBe(true);
    expect(message.matchesPayload('hash-2')).toBe(false);
  });

  it('rehydrates a processed message without validating', () => {
    const message = InboxMessage.rehydrate({
      consumerName: 'wallet-events-audit',
      messageId: 'msg-2',
      payloadHash: 'hash-2',
      receivedAt,
      processedAt,
    });
    expect(message.isProcessed()).toBe(true);
    expect(message.toState().processedAt).toEqual(processedAt);
  });
});
