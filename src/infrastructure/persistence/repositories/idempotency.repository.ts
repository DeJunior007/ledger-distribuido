import type { EntityManager } from '@mikro-orm/postgresql';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import type { IdempotencyRepositoryPort } from '@application/ports/repositories/idempotency-repository.port';
import type { IdempotencyRecord } from '@domain/idempotency/idempotency-record';
import * as idempotencyRecordMapper from '../mappers/idempotency-record.mapper';
import { IdempotencyRecordRecord } from '../records/idempotency-records.record';

export class MikroOrmIdempotencyRepository implements IdempotencyRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async find(
    providerId: string,
    idempotencyKey: string,
    options?: { refresh?: boolean },
  ): Promise<IdempotencyRecord | undefined> {
    const record = await this.em.findOne(
      IdempotencyRecordRecord,
      { providerId, idempotencyKey },
      { refresh: options?.refresh ?? false },
    );
    return record === null ? undefined : idempotencyRecordMapper.toDomain(record);
  }

  insert(record: IdempotencyRecord): void {
    this.em.persist(idempotencyRecordMapper.toRecord(record));
  }

  update(record: IdempotencyRecord): void {
    const { providerId, idempotencyKey } = record.toState();
    const existing =
      this.em.getUnitOfWork().tryGetById<IdempotencyRecordRecord>(IdempotencyRecordRecord.name, {
        providerId,
        idempotencyKey,
      }) ?? undefined;
    if (existing === undefined) {
      throw new TechnicalError(ErrorClass.Deterministic, 'deterministic');
    }
    this.em.persist(idempotencyRecordMapper.toRecord(record, existing));
  }
}
