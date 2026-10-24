import type { EntityManager } from '@mikro-orm/postgresql';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import type { HouseAccountRepositoryPort } from '@application/ports/repositories/house-account-repository.port';

const unavailable = (): TechnicalError =>
  new TechnicalError(ErrorClass.Deterministic, 'deterministic');

export class MikroOrmHouseAccountRepository implements HouseAccountRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  ensure(): Promise<never> {
    return Promise.reject(unavailable());
  }

  findByCurrencyAndPurpose(): Promise<never> {
    return Promise.reject(unavailable());
  }
}
