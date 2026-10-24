import { InMemoryUnitOfWork } from '@test/support/fakes/in-memory-unit-of-work.fake';
import type { Repositories, TransactionKind } from '@application/ports/unit-of-work.port';
import { toCurrencyCode } from '@domain/shared/currency';
import { Money } from '@domain/shared/money';
import { HouseAccountPurpose } from '@domain/wallet/house-account';
import { LedgerDirection } from '@domain/wallet/ledger-direction';
import { at } from './fixtures';

export class RecordingUnitOfWork extends InMemoryUnitOfWork {
  readonly kinds: TransactionKind[] = [];

  override run<T>(kind: TransactionKind, work: (repos: Repositories) => Promise<T>): Promise<T> {
    this.kinds.push(kind);
    return super.run(kind, work);
  }
}

export interface Movement {
  direction: LedgerDirection;
  amount: string;
}

export interface LedgerWalletSeed {
  id: string;
  currency?: string;
  openedWithZero?: boolean;
  movements: readonly Movement[];
  omittedVersions?: readonly number[];
}

export const credit = (amount: string): Movement => ({ direction: LedgerDirection.Credit, amount });
export const debit = (amount: string): Movement => ({ direction: LedgerDirection.Debit, amount });

const opposite = (direction: LedgerDirection): LedgerDirection =>
  direction === LedgerDirection.Credit ? LedgerDirection.Debit : LedgerDirection.Credit;

const houseAccountId = (currency: string, purpose: HouseAccountPurpose): string =>
  `${purpose}-${currency}`;

export const seedHouseAccounts = (uow: InMemoryUnitOfWork, currency: string): void => {
  for (const purpose of [HouseAccountPurpose.Funding, HouseAccountPurpose.Gaming]) {
    uow.database.houseAccounts.put({
      id: houseAccountId(currency, purpose),
      currency: toCurrencyCode(currency),
      purpose,
      createdAt: at,
    });
  }
};

export const seedLedgerWallet = (uow: InMemoryUnitOfWork, seed: LedgerWalletSeed): void => {
  const currency = seed.currency ?? 'BRL';
  const firstVersion = seed.openedWithZero === true ? 2 : 1;
  const omitted = new Set(seed.omittedVersions ?? []);
  let balance = Money.zero(currency);
  let version = 1;
  seed.movements.forEach((movement, index) => {
    version = firstVersion + index;
    const money = Money.from({ amount: movement.amount, currency });
    const balanceBefore = balance;
    balance =
      movement.direction === LedgerDirection.Credit
        ? balanceBefore.add(money)
        : balanceBefore.subtract(money);
    if (omitted.has(version)) {
      return;
    }
    const transactionId = `${seed.id}-tx-${String(version)}`;
    uow.database.walletEntries.put({
      id: `${seed.id}-entry-${String(version)}`,
      walletId: seed.id,
      transactionId,
      direction: movement.direction,
      money,
      balanceBefore,
      balanceAfter: balance,
      walletVersion: version,
      createdAt: at,
    });
    uow.database.houseEntries.put({
      id: `${seed.id}-house-${String(version)}`,
      houseAccountId: houseAccountId(
        currency,
        version === 1 ? HouseAccountPurpose.Funding : HouseAccountPurpose.Gaming,
      ),
      transactionId,
      direction: opposite(movement.direction),
      money,
      createdAt: at,
    });
  });
  uow.database.wallets.put({
    id: seed.id,
    playerId: `player-${seed.id}`,
    currency: toCurrencyCode(currency),
    balance,
    version,
    createdAt: at,
    updatedAt: at,
  });
};

export const overwriteWallet = (
  uow: InMemoryUnitOfWork,
  walletId: string,
  changes: { balance?: string; version?: number },
): void => {
  const wallet = uow.database.wallets.get(walletId);
  if (wallet === undefined) {
    throw new TypeError(`wallet ${walletId} was not seeded`);
  }
  uow.database.wallets.put({
    ...wallet,
    balance:
      changes.balance === undefined
        ? wallet.balance
        : Money.from({ amount: changes.balance, currency: wallet.currency }),
    version: changes.version ?? wallet.version,
  });
};
