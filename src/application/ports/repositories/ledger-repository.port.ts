import type { LedgerPosting } from '@domain/wallet/ledger-posting';
import type { WalletLedgerEntry } from '@domain/wallet/wallet-ledger-entry';

export abstract class LedgerRepositoryPort {
  abstract insertPosting(posting: LedgerPosting): void;
  abstract listWalletEntries(
    walletId: string,
    page: { beforeVersion: number | undefined; limit: number },
  ): Promise<WalletLedgerEntry[]>;
}
