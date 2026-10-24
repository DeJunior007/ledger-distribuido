import type { EntityManager } from '@mikro-orm/postgresql';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import type { LedgerRepositoryPort } from '@application/ports/repositories/ledger-repository.port';

const unavailable = (): TechnicalError =>
  new TechnicalError(ErrorClass.Deterministic, 'deterministic');

export class MikroOrmLedgerRepository implements LedgerRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  insertPosting(): never {
    throw unavailable();
  }

  listWalletEntries(): Promise<never> {
    return Promise.reject(unavailable());
  }
}
