import type { MoneyProps } from '@domain/shared/money';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface WalletBalanceView {
  id: string;
  balance: MoneyProps;
  version: number;
}
