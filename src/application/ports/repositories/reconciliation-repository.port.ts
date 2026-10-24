import type { Money } from '@domain/shared/money';
import type { LedgerDirection } from '@domain/wallet/ledger-direction';

export interface WalletSnapshot {
  walletId: string;
  currency: string;
  balance: string;
  version: number;
  credits: string;
  debits: string;
  entries: number;
  chain: {
    walletVersion: number;
    direction: LedgerDirection;
    amount: string;
    currency: string;
    balanceBefore: string;
    balanceAfter: string;
  }[];
}

export interface CurrencySums {
  currency: string;
  walletsTotal: string;
  fundingBalance: string;
  gamingBalance: string;
  ledgerNet: string;
}

export interface WalletBatchRow {
  walletId: string;
  balance: string;
  version: number;
  calculated: string;
  entries: number;
  firstVersion: number | undefined;
  lastVersion: number | undefined;
}

export interface ReconciliationRunInput {
  id: string;
  scope: 'WALLET' | 'GLOBAL';
  walletId: string | undefined;
  consistent: boolean;
  checkedEntries: number;
  stored: Money | undefined;
  calculated: Money | undefined;
  difference: Money | undefined;
  currency: string | undefined;
  firstDivergentVersion: number | undefined;
  details: Readonly<Record<string, unknown>>;
  startedAt: Date;
  finishedAt: Date;
}

export abstract class ReconciliationRepositoryPort {
  abstract walletSnapshot(walletId: string): Promise<WalletSnapshot | undefined>;
  abstract globalSums(): Promise<CurrencySums[]>;
  abstract walletBatch(afterId: string | undefined, limit: number): Promise<WalletBatchRow[]>;
  abstract insertRun(run: ReconciliationRunInput): void;
}
