import type { EntityManager } from '@mikro-orm/postgresql';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import type { InboxRepositoryPort } from '@application/ports/repositories/inbox-repository.port';

const unavailable = (): TechnicalError =>
  new TechnicalError(ErrorClass.Deterministic, 'deterministic');

export class MikroOrmInboxRepository implements InboxRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  find(): Promise<never> {
    return Promise.reject(unavailable());
  }

  tryInsert(): Promise<never> {
    return Promise.reject(unavailable());
  }

  markProcessed(): Promise<never> {
    return Promise.reject(unavailable());
  }
}
