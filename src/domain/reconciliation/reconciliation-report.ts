import type { Money } from '../shared/money';
import type { ChainProblem } from './ledger-chain';

export interface ReconciliationChainReport {
  valid: boolean;
  firstDivergentVersion: number | undefined;
  problems: ChainProblem[];
}

export interface WalletReconciliationReport {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
  chain: ReconciliationChainReport;
  runId: string;
  checkedAt: Date;
}
