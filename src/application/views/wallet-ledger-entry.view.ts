import type { MoneyProps } from '@domain/shared/money';
import type { LedgerDirection } from '@domain/wallet/ledger-direction';

export interface WalletLedgerEntryView {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}
