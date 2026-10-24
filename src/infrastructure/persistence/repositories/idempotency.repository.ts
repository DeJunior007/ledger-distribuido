import type { EntityManager } from '@mikro-orm/postgresql';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import type { IdempotencyRepositoryPort } from '@application/ports/repositories/idempotency-repository.port';

const unavailable = (): TechnicalError =>
  new TechnicalError(ErrorClass.Deterministic, 'deterministic');

export class MikroOrmIdempotencyRepository implements IdempotencyRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  find(): Promise<never> {
    return Promise.reject(unavailable());
  }

  insert(): never {
    throw unavailable();
  }

  update(): never {
    throw unavailable();
  }
}
