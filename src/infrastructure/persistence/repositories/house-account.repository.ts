import type { EntityManager } from '@mikro-orm/postgresql';
import { z } from 'zod';
import type { HouseAccountRepositoryPort } from '@application/ports/repositories/house-account-repository.port';
import type { HouseAccount, HouseAccountPurpose } from '@domain/wallet/house-account';
import * as houseAccountMapper from '../mappers/house-account.mapper';
import { corruptedRow } from '../mappers/persisted-values.mapper';
import { HouseAccountRecord } from '../records/house-accounts.record';
import { houseAccountRowSchema } from '../rows/house-accounts.row';

const ENSURE_SQL = `INSERT INTO house_accounts (id, currency, purpose, created_at)
VALUES (?, ?, ?, ?)
ON CONFLICT (currency, purpose) DO NOTHING
RETURNING id, currency, purpose, created_at`;

const insertedRowsSchema = z.array(houseAccountRowSchema).max(1);

export class MikroOrmHouseAccountRepository implements HouseAccountRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async ensure(
    currency: string,
    purpose: HouseAccountPurpose,
    idIfNew: string,
    now: Date,
  ): Promise<HouseAccount> {
    const parsed = insertedRowsSchema.safeParse(
      await this.em.execute(ENSURE_SQL, [idIfNew, currency, purpose, now]),
    );
    if (!parsed.success) {
      throw corruptedRow();
    }
    const inserted = parsed.data[0];
    if (inserted !== undefined) {
      return houseAccountMapper.toDomain(this.em.map(HouseAccountRecord, inserted));
    }
    const existing = await this.em.findOne(HouseAccountRecord, { currency, purpose });
    if (existing === null) {
      throw corruptedRow();
    }
    return houseAccountMapper.toDomain(existing);
  }

  async findByCurrencyAndPurpose(
    currency: string,
    purpose: HouseAccountPurpose,
  ): Promise<HouseAccount | undefined> {
    const record = await this.em.findOne(HouseAccountRecord, { currency, purpose });
    return record === null ? undefined : houseAccountMapper.toDomain(record);
  }
}
