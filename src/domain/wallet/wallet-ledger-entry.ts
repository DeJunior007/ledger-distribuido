import type { Money } from '../shared/money';
import { UnbalancedLedgerEntryError } from './errors/unbalanced-ledger-entry.error';
import { LedgerDirection } from './ledger-direction';

export interface WalletLedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number;
  createdAt: Date;
}

function expectedBalanceAfter(state: WalletLedgerEntryState): Money {
  return state.direction === LedgerDirection.Credit
    ? state.balanceBefore.add(state.money)
    : state.balanceBefore.subtract(state.money);
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    public readonly createdAt: Date,
  ) {}

  static create(props: WalletLedgerEntryState): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new UnbalancedLedgerEntryError('ledger entry money must be positive');
    }
    if (
      props.money.currency !== props.balanceBefore.currency ||
      props.money.currency !== props.balanceAfter.currency
    ) {
      throw new UnbalancedLedgerEntryError('ledger entry currencies must match');
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new UnbalancedLedgerEntryError('ledger entry balances must not be negative');
    }
    if (!expectedBalanceAfter(props).equals(props.balanceAfter)) {
      throw new UnbalancedLedgerEntryError('ledger entry balance does not add up');
    }
    if (!Number.isInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new UnbalancedLedgerEntryError('ledger entry wallet version must be an integer >= 1');
    }
    return WalletLedgerEntry.rehydrate(props);
  }

  static rehydrate(state: WalletLedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    if (
      this.money.currency !== this.balanceBefore.currency ||
      this.money.currency !== this.balanceAfter.currency
    ) {
      return false;
    }
    return expectedBalanceAfter(this).equals(this.balanceAfter);
  }
}
