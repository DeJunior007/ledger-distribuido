import type { EntityManager } from '@mikro-orm/postgresql';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import type { WalletRepositoryPort } from '@application/ports/repositories/wallet-repository.port';

const unavailable = (): TechnicalError =>
  new TechnicalError(ErrorClass.Deterministic, 'deterministic');

export class MikroOrmWalletRepository implements WalletRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  lockById(): Promise<never> {
    return Promise.reject(unavailable());
  }

  findById(): Promise<never> {
    return Promise.reject(unavailable());
  }

  findByPlayerAndCurrency(): Promise<never> {
    return Promise.reject(unavailable());
  }

  insert(): never {
    throw unavailable();
  }

  update(): never {
    throw unavailable();
  }

  assertPersistedVersion(): Promise<never> {
    return Promise.reject(unavailable());
  }
}
