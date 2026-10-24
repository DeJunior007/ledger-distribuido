import type { EntityManager } from '@mikro-orm/postgresql';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import type { ScheduledJobRepositoryPort } from '@application/ports/repositories/scheduled-job-repository.port';

const unavailable = (): TechnicalError =>
  new TechnicalError(ErrorClass.Deterministic, 'deterministic');

export class MikroOrmScheduledJobRepository implements ScheduledJobRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  tryAcquire(): Promise<never> {
    return Promise.reject(unavailable());
  }

  complete(): Promise<never> {
    return Promise.reject(unavailable());
  }
}
