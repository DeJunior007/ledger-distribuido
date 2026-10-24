import type { EntityManager } from '@mikro-orm/postgresql';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import type { ReconciliationRepositoryPort } from '@application/ports/repositories/reconciliation-repository.port';

const unavailable = (): TechnicalError =>
  new TechnicalError(ErrorClass.Deterministic, 'deterministic');

export class MikroOrmReconciliationRepository implements ReconciliationRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  walletSnapshot(): Promise<never> {
    return Promise.reject(unavailable());
  }

  globalSums(): Promise<never> {
    return Promise.reject(unavailable());
  }

  walletBatch(): Promise<never> {
    return Promise.reject(unavailable());
  }

  insertRun(): never {
    throw unavailable();
  }
}
