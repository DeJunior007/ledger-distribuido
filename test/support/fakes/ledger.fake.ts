import { LedgerRepositoryPort } from '@application/ports/repositories/ledger-repository.port';
import type { LedgerPosting } from '@domain/wallet/ledger-posting';
import { WalletLedgerEntry } from '@domain/wallet/wallet-ledger-entry';
import { settle } from './in-memory-unit-of-work.fake';
import type { FakeTransaction } from './in-memory-unit-of-work.fake';

export class InMemoryLedgerRepository extends LedgerRepositoryPort {
  constructor(private readonly transaction: FakeTransaction) {
    super();
  }

  insertPosting(posting: LedgerPosting): void {
    const { walletEntry, houseEntry } = posting;
    this.transaction.walletEntries.insert({
      id: walletEntry.id,
      walletId: walletEntry.walletId,
      transactionId: walletEntry.transactionId,
      direction: walletEntry.direction,
      money: walletEntry.money,
      balanceBefore: walletEntry.balanceBefore,
      balanceAfter: walletEntry.balanceAfter,
      walletVersion: walletEntry.walletVersion,
      createdAt: walletEntry.createdAt,
    });
    this.transaction.houseEntries.insert({
      id: houseEntry.id,
      houseAccountId: houseEntry.houseAccountId,
      transactionId: houseEntry.transactionId,
      direction: houseEntry.direction,
      money: houseEntry.money,
      createdAt: houseEntry.createdAt,
    });
  }

  listWalletEntries(
    walletId: string,
    page: { beforeVersion: number | undefined; limit: number },
  ): Promise<WalletLedgerEntry[]> {
    return settle(() =>
      this.transaction.walletEntries
        .rows()
        .filter(
          (entry) =>
            entry.walletId === walletId &&
            (page.beforeVersion === undefined || entry.walletVersion < page.beforeVersion),
        )
        .sort((left, right) => right.walletVersion - left.walletVersion)
        .slice(0, page.limit)
        .map((entry) => WalletLedgerEntry.rehydrate(entry)),
    );
  }
}
