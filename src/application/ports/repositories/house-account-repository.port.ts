import type { HouseAccount, HouseAccountPurpose } from '@domain/wallet/house-account';

export abstract class HouseAccountRepositoryPort {
  abstract ensure(
    currency: string,
    purpose: HouseAccountPurpose,
    idIfNew: string,
    now: Date,
  ): Promise<HouseAccount>;
  abstract findByCurrencyAndPurpose(
    currency: string,
    purpose: HouseAccountPurpose,
  ): Promise<HouseAccount | undefined>;
}
