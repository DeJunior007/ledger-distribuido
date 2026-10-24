import { toCurrencyCode } from '@domain/shared/currency';
import { HouseAccount, HouseAccountPurpose } from '@domain/wallet/house-account';
import { HouseAccountRecord } from '../records/house-accounts.record';
import { parseEnum } from './persisted-values.mapper';

export function toDomain(record: HouseAccountRecord): HouseAccount {
  return HouseAccount.rehydrate({
    id: record.id,
    currency: toCurrencyCode(record.currency),
    purpose: parseEnum(HouseAccountPurpose, record.purpose),
    createdAt: record.createdAt,
  });
}

export function toRecord(account: HouseAccount, existing?: HouseAccountRecord): HouseAccountRecord {
  return (
    existing ??
    new HouseAccountRecord({
      id: account.id,
      currency: account.currency,
      purpose: account.purpose,
      createdAt: account.createdAt,
    })
  );
}
