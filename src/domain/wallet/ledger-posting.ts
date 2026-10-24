import { InvalidLedgerPostingError } from './errors/invalid-ledger-posting.error';
import type { HouseLedgerEntry } from './house-ledger-entry';
import { oppositeDirection } from './ledger-direction';
import type { WalletLedgerEntry } from './wallet-ledger-entry';

export interface LedgerPostingProps {
  walletEntry: WalletLedgerEntry;
  houseEntry: HouseLedgerEntry;
}

export class LedgerPosting {
  private constructor(
    public readonly walletEntry: WalletLedgerEntry,
    public readonly houseEntry: HouseLedgerEntry,
  ) {}

  static create(props: LedgerPostingProps): LedgerPosting {
    const { walletEntry, houseEntry } = props;
    if (houseEntry.direction !== oppositeDirection(walletEntry.direction)) {
      throw new InvalidLedgerPostingError('posting entries must have opposite directions');
    }
    if (!walletEntry.money.equals(houseEntry.money)) {
      throw new InvalidLedgerPostingError('posting entries must have the same money');
    }
    if (walletEntry.transactionId !== houseEntry.transactionId) {
      throw new InvalidLedgerPostingError('posting entries must share the same transaction');
    }
    return new LedgerPosting(walletEntry, houseEntry);
  }
}
