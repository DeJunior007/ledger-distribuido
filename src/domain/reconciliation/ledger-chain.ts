import { LedgerDirection } from '../wallet/ledger-direction';
import type { Money } from '../shared/money';

export interface ChainRow {
  walletVersion: number;
  direction: LedgerDirection;
  amount: Money;
  balanceBefore: Money;
  balanceAfter: Money;
}

export type ChainProblem =
  | 'START_NOT_ZERO'
  | 'INVALID_FIRST_VERSION'
  | 'VERSION_GAP'
  | 'BEFORE_AFTER_MISMATCH'
  | 'UNBALANCED_ENTRY'
  | 'LAST_VERSION_MISMATCH'
  | 'LAST_BALANCE_MISMATCH'
  | 'EMPTY_LEDGER_MISMATCH';

export interface LedgerChainResult {
  valid: boolean;
  firstDivergentVersion: number | undefined;
  problems: ChainProblem[];
}

const PROBLEM_ORDER: readonly ChainProblem[] = [
  'EMPTY_LEDGER_MISMATCH',
  'INVALID_FIRST_VERSION',
  'START_NOT_ZERO',
  'VERSION_GAP',
  'BEFORE_AFTER_MISMATCH',
  'UNBALANCED_ENTRY',
  'LAST_VERSION_MISMATCH',
  'LAST_BALANCE_MISMATCH',
];

function appliedBalance(row: ChainRow): Money {
  return row.direction === LedgerDirection.Credit
    ? row.balanceBefore.add(row.amount)
    : row.balanceBefore.subtract(row.amount);
}

export function verifyLedgerChain(input: {
  rows: ChainRow[];
  walletVersion: number;
  storedBalance: Money;
}): LedgerChainResult {
  const found = new Map<ChainProblem, number>();
  const report = (problem: ChainProblem, version: number): void => {
    const current = found.get(problem);
    if (current === undefined || version < current) {
      found.set(problem, version);
    }
  };

  const rows = [...input.rows].sort((a, b) => a.walletVersion - b.walletVersion);
  const first = rows[0];
  const last = rows[rows.length - 1];

  if (first === undefined || last === undefined) {
    if (input.walletVersion !== 1 || !input.storedBalance.isZero()) {
      report('EMPTY_LEDGER_MISMATCH', input.walletVersion);
    }
  } else {
    if (first.walletVersion !== 1 && first.walletVersion !== 2) {
      report('INVALID_FIRST_VERSION', first.walletVersion);
    }
    if (!first.balanceBefore.isZero()) {
      report('START_NOT_ZERO', first.walletVersion);
    }
    rows.forEach((row, index) => {
      if (!appliedBalance(row).equals(row.balanceAfter)) {
        report('UNBALANCED_ENTRY', row.walletVersion);
      }
      const previous = rows[index - 1];
      if (previous !== undefined) {
        if (row.walletVersion !== previous.walletVersion + 1) {
          report('VERSION_GAP', row.walletVersion);
        }
        if (!row.balanceBefore.equals(previous.balanceAfter)) {
          report('BEFORE_AFTER_MISMATCH', row.walletVersion);
        }
      }
    });
    if (last.walletVersion !== input.walletVersion) {
      report('LAST_VERSION_MISMATCH', last.walletVersion);
    }
    if (!last.balanceAfter.equals(input.storedBalance)) {
      report('LAST_BALANCE_MISMATCH', last.walletVersion);
    }
  }

  const problems = PROBLEM_ORDER.filter((problem) => found.has(problem));
  const versions = [...found.values()];
  return {
    valid: problems.length === 0,
    firstDivergentVersion: versions.length === 0 ? undefined : Math.min(...versions),
    problems,
  };
}
