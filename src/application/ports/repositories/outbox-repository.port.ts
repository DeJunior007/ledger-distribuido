import type { OutboxMessage } from '@domain/messaging/outbox-message';
import type { OutboxGauges } from '../outbox-gauges';

export abstract class OutboxRepositoryPort {
  abstract enqueue(message: OutboxMessage): void;
  abstract claimDue(input: {
    instanceId: string;
    leaseMs: number;
    limit: number;
  }): Promise<OutboxMessage[]>;
  abstract markPublished(id: string, instanceId: string, at: Date): Promise<boolean>;
  abstract saveRetry(message: OutboxMessage, instanceId: string): Promise<boolean>;
  abstract requeueParked(limit: number | undefined): Promise<number>;
  abstract gauges(now: Date): Promise<OutboxGauges>;
}
