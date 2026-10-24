import { IdempotencyRepositoryPort } from '@application/ports/repositories/idempotency-repository.port';
import { IdempotencyRecord } from '@domain/idempotency/idempotency-record';
import { compositeKey, settle } from './in-memory-unit-of-work.fake';
import type { FakeTransaction } from './in-memory-unit-of-work.fake';

export class InMemoryIdempotencyRepository extends IdempotencyRepositoryPort {
  constructor(private readonly transaction: FakeTransaction) {
    super();
  }

  find(providerId: string, idempotencyKey: string): Promise<IdempotencyRecord | undefined> {
    return settle(() => {
      const row = this.transaction.idempotency.find(compositeKey(providerId, idempotencyKey));
      return row === undefined ? undefined : IdempotencyRecord.rehydrate(row);
    });
  }

  insert(record: IdempotencyRecord): void {
    this.transaction.idempotency.insert(record.toState());
  }

  update(record: IdempotencyRecord): void {
    this.transaction.idempotency.update(record.toState());
  }
}
