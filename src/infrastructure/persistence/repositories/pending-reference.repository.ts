import type { EntityManager } from '@mikro-orm/postgresql';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import type { PendingReferenceRepositoryPort } from '@application/ports/repositories/pending-reference-repository.port';

const unavailable = (): TechnicalError =>
  new TechnicalError(ErrorClass.Deterministic, 'deterministic');

export class MikroOrmPendingReferenceRepository implements PendingReferenceRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  insert(): never {
    throw unavailable();
  }

  claimDue(): Promise<never> {
    return Promise.reject(unavailable());
  }

  renewLease(): Promise<never> {
    return Promise.reject(unavailable());
  }

  scheduleNext(): Promise<never> {
    return Promise.reject(unavailable());
  }

  markResolved(): Promise<never> {
    return Promise.reject(unavailable());
  }

  wakeDependents(): Promise<never> {
    return Promise.reject(unavailable());
  }

  openCount(): Promise<never> {
    return Promise.reject(unavailable());
  }
}
