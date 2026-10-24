import { HouseAccountRepositoryPort } from '@application/ports/repositories/house-account-repository.port';
import { toCurrencyCode } from '@domain/shared/currency';
import { HouseAccount, type HouseAccountPurpose } from '@domain/wallet/house-account';
import { settle } from './in-memory-unit-of-work.fake';
import type { FakeTransaction } from './in-memory-unit-of-work.fake';

export class InMemoryHouseAccountRepository extends HouseAccountRepositoryPort {
  constructor(private readonly transaction: FakeTransaction) {
    super();
  }

  ensure(
    currency: string,
    purpose: HouseAccountPurpose,
    idIfNew: string,
    now: Date,
  ): Promise<HouseAccount> {
    return settle(() => {
      const existing = this.find(currency, purpose);
      if (existing !== undefined) {
        return existing;
      }
      const state = { id: idIfNew, currency: toCurrencyCode(currency), purpose, createdAt: now };
      this.transaction.houseAccounts.insert(state);
      return HouseAccount.rehydrate(state);
    });
  }

  findByCurrencyAndPurpose(
    currency: string,
    purpose: HouseAccountPurpose,
  ): Promise<HouseAccount | undefined> {
    return settle(() => this.find(currency, purpose));
  }

  private find(currency: string, purpose: HouseAccountPurpose): HouseAccount | undefined {
    const row = this.transaction.houseAccounts
      .rows()
      .find((candidate) => candidate.currency === currency && candidate.purpose === purpose);
    return row === undefined ? undefined : HouseAccount.rehydrate(row);
  }
}
