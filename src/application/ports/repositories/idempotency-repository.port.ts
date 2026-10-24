import type { IdempotencyRecord } from '@domain/idempotency/idempotency-record';

export abstract class IdempotencyRepositoryPort {
  abstract find(
    providerId: string,
    idempotencyKey: string,
    options?: { refresh?: boolean },
  ): Promise<IdempotencyRecord | undefined>;
  abstract insert(record: IdempotencyRecord): void;
  abstract update(record: IdempotencyRecord): void;
}
