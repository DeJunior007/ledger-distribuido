import type { Money } from '../shared/money';
import { UnbalancedLedgerEntryError } from './errors/unbalanced-ledger-entry.error';
import type { LedgerDirection } from './ledger-direction';

export interface HouseLedgerEntryState {
  id: string;
  houseAccountId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  createdAt: Date;
}

export class HouseLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly houseAccountId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: HouseLedgerEntryState): HouseLedgerEntry {
    if (!props.money.isPositive()) {
      throw new UnbalancedLedgerEntryError('ledger entry money must be positive');
    }
    return HouseLedgerEntry.rehydrate(props);
  }

  static rehydrate(state: HouseLedgerEntryState): HouseLedgerEntry {
    return new HouseLedgerEntry(
      state.id,
      state.houseAccountId,
      state.transactionId,
      state.direction,
      state.money,
      state.createdAt,
    );
  }
}
