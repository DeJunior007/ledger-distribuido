import type { OutboxMessage } from '@domain/messaging/outbox-message';

export type PublishOutcome =
  | { id: string; result: 'published' }
  | { id: string; result: 'failed'; kind: 'TRANSIENT' | 'PERMANENT'; errorCode: string };

export abstract class EventPublisherPort {
  abstract publishBatch(
    messages: OutboxMessage[],
  ): Promise<{ outcomes: PublishOutcome[]; connectivityFailure: boolean }>;
}
