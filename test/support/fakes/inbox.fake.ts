import { InboxRepositoryPort } from '@application/ports/repositories/inbox-repository.port';
import { InboxMessage } from '@domain/messaging/inbox-message';
import { compositeKey, settle } from './in-memory-unit-of-work.fake';
import type { FakeTransaction } from './in-memory-unit-of-work.fake';

export class InMemoryInboxRepository extends InboxRepositoryPort {
  constructor(private readonly transaction: FakeTransaction) {
    super();
  }

  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    return settle(() => {
      const row = this.transaction.inbox.find(compositeKey(consumerName, messageId));
      return row === undefined ? undefined : InboxMessage.rehydrate(row);
    });
  }

  tryInsert(message: InboxMessage): Promise<boolean> {
    return settle(() => {
      const state = message.toState();
      if (
        this.transaction.inbox.find(compositeKey(state.consumerName, state.messageId)) !== undefined
      ) {
        return false;
      }
      this.transaction.inbox.insert(state);
      return true;
    });
  }

  markProcessed(message: InboxMessage): Promise<void> {
    return settle(() => {
      const existing = this.transaction.inbox.find(
        compositeKey(message.consumerName, message.messageId),
      );
      if (existing === undefined) {
        return;
      }
      this.transaction.inbox.update({ ...existing, processedAt: message.processedAt });
    });
  }
}
