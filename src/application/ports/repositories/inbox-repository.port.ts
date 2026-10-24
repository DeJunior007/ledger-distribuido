import type { InboxMessage } from '@domain/messaging/inbox-message';

export abstract class InboxRepositoryPort {
  abstract find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  abstract tryInsert(message: InboxMessage): Promise<boolean>;
  abstract markProcessed(message: InboxMessage): Promise<void>;
}
