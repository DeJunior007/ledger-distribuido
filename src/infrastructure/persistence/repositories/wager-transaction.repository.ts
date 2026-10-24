import type { EntityManager } from '@mikro-orm/postgresql';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import type { WagerTransactionRepositoryPort } from '@application/ports/repositories/wager-transaction-repository.port';

const unavailable = (): TechnicalError =>
  new TechnicalError(ErrorClass.Deterministic, 'deterministic');

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  findById(): Promise<never> {
    return Promise.reject(unavailable());
  }

  findByProviderAndExternalId(): Promise<never> {
    return Promise.reject(unavailable());
  }

  isReversed(): Promise<never> {
    return Promise.reject(unavailable());
  }

  hasProcessedWinInRound(): Promise<never> {
    return Promise.reject(unavailable());
  }

  insert(): never {
    throw unavailable();
  }

  update(): never {
    throw unavailable();
  }
}
