import { describe, expect, it } from 'bun:test';
import { verifyLedgerChain, type ChainRow } from '@domain/reconciliation/ledger-chain';
import { Money } from '@domain/shared/money';
import { LedgerDirection } from '@domain/wallet/ledger-direction';

const brl = (amount: string): Money => Money.fromSignedDecimal(amount, 'BRL');

function row(
  walletVersion: number,
  direction: LedgerDirection,
  amount: string,
  before: string,
  after: string,
): ChainRow {
  return {
    walletVersion,
    direction,
    amount: brl(amount),
    balanceBefore: brl(before),
    balanceAfter: brl(after),
  };
}

const credit = LedgerDirection.Credit;
const debit = LedgerDirection.Debit;

const validRows = (): ChainRow[] => [
  row(1, credit, '100.00', '0.00', '100.00'),
  row(2, debit, '30.00', '100.00', '70.00'),
  row(3, credit, '5.00', '70.00', '75.00'),
];

describe('verifyLedgerChain', () => {
  it('accepts a valid chain starting at version 1', () => {
    const result = verifyLedgerChain({
      rows: validRows(),
      walletVersion: 3,
      storedBalance: brl('75.00'),
    });
    expect(result).toEqual({ valid: true, firstDivergentVersion: undefined, problems: [] });
  });

  it('accepts a valid chain starting at version 2 when the wallet opened with zero', () => {
    const rows = [row(2, credit, '10.00', '0.00', '10.00'), row(3, debit, '4.00', '10.00', '6.00')];
    const result = verifyLedgerChain({ rows, walletVersion: 3, storedBalance: brl('6.00') });
    expect(result.valid).toBe(true);
  });

  it('accepts an empty ledger at version 1 with zero balance', () => {
    const result = verifyLedgerChain({
      rows: [],
      walletVersion: 1,
      storedBalance: brl('0.00'),
    });
    expect(result).toEqual({ valid: true, firstDivergentVersion: undefined, problems: [] });
  });

  it('flags an empty ledger with a wrong version', () => {
    const result = verifyLedgerChain({ rows: [], walletVersion: 2, storedBalance: brl('0.00') });
    expect(result.problems).toEqual(['EMPTY_LEDGER_MISMATCH']);
    expect(result.valid).toBe(false);
  });

  it('flags an empty ledger with a non-zero balance', () => {
    const result = verifyLedgerChain({ rows: [], walletVersion: 1, storedBalance: brl('1.00') });
    expect(result.problems).toEqual(['EMPTY_LEDGER_MISMATCH']);
  });

  it('flags an invalid first version', () => {
    const rows = [row(3, credit, '10.00', '0.00', '10.00')];
    const result = verifyLedgerChain({ rows, walletVersion: 3, storedBalance: brl('10.00') });
    expect(result.problems).toEqual(['INVALID_FIRST_VERSION']);
    expect(result.firstDivergentVersion).toBe(3);
  });

  it('flags a first entry that does not start from zero', () => {
    const rows = [row(1, credit, '10.00', '5.00', '15.00')];
    const result = verifyLedgerChain({ rows, walletVersion: 1, storedBalance: brl('15.00') });
    expect(result.problems).toEqual(['START_NOT_ZERO']);
    expect(result.firstDivergentVersion).toBe(1);
  });

  it('flags a version gap', () => {
    const rows = [
      row(1, credit, '100.00', '0.00', '100.00'),
      row(3, debit, '30.00', '100.00', '70.00'),
    ];
    const result = verifyLedgerChain({ rows, walletVersion: 3, storedBalance: brl('70.00') });
    expect(result.problems).toEqual(['VERSION_GAP']);
    expect(result.firstDivergentVersion).toBe(3);
  });

  it('flags a before balance that differs from the previous after balance', () => {
    const rows = [
      row(1, credit, '100.00', '0.00', '100.00'),
      row(2, debit, '30.00', '90.00', '60.00'),
    ];
    const result = verifyLedgerChain({ rows, walletVersion: 2, storedBalance: brl('60.00') });
    expect(result.problems).toEqual(['BEFORE_AFTER_MISMATCH']);
    expect(result.firstDivergentVersion).toBe(2);
  });

  it('flags an unbalanced entry', () => {
    const rows = [
      row(1, credit, '100.00', '0.00', '100.00'),
      row(2, debit, '30.00', '100.00', '80.00'),
    ];
    const result = verifyLedgerChain({ rows, walletVersion: 2, storedBalance: brl('80.00') });
    expect(result.problems).toEqual(['UNBALANCED_ENTRY']);
    expect(result.firstDivergentVersion).toBe(2);
  });

  it('flags a last version that differs from the wallet version', () => {
    const result = verifyLedgerChain({
      rows: validRows(),
      walletVersion: 4,
      storedBalance: brl('75.00'),
    });
    expect(result.problems).toEqual(['LAST_VERSION_MISMATCH']);
    expect(result.firstDivergentVersion).toBe(3);
  });

  it('flags a last balance that differs from the stored balance', () => {
    const result = verifyLedgerChain({
      rows: validRows(),
      walletVersion: 3,
      storedBalance: brl('76.00'),
    });
    expect(result.problems).toEqual(['LAST_BALANCE_MISMATCH']);
    expect(result.firstDivergentVersion).toBe(3);
  });

  it('reports the smallest divergent version across problems', () => {
    const rows = [
      row(1, credit, '100.00', '0.00', '100.00'),
      row(2, debit, '30.00', '100.00', '80.00'),
      row(3, credit, '5.00', '80.00', '85.00'),
    ];
    const result = verifyLedgerChain({ rows, walletVersion: 3, storedBalance: brl('90.00') });
    expect(result.problems).toEqual(['UNBALANCED_ENTRY', 'LAST_BALANCE_MISMATCH']);
    expect(result.firstDivergentVersion).toBe(2);
  });
});
