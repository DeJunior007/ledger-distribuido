import type { EntityManager } from '@mikro-orm/postgresql';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import type { OutboxRepositoryPort } from '@application/ports/repositories/outbox-repository.port';

const unavailable = (): TechnicalError =>
  new TechnicalError(ErrorClass.Deterministic, 'deterministic');

export class MikroOrmOutboxRepository implements OutboxRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  enqueue(): never {
    throw unavailable();
  }

  claimDue(): Promise<never> {
    return Promise.reject(unavailable());
  }

  markPublished(): Promise<never> {
    return Promise.reject(unavailable());
  }

  saveRetry(): Promise<never> {
    return Promise.reject(unavailable());
  }

  requeueParked(): Promise<never> {
    return Promise.reject(unavailable());
  }

  gauges(): Promise<never> {
    return Promise.reject(unavailable());
  }
}
