import { describe, expect, it } from 'bun:test';
import { Money } from '@domain/shared/money';
import { UnbalancedLedgerEntryError } from '@domain/wallet/errors/unbalanced-ledger-entry.error';
import { LedgerDirection } from '@domain/wallet/ledger-direction';
import { WalletLedgerEntry, type WalletLedgerEntryState } from '@domain/wallet/wallet-ledger-entry';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const valid = (overrides: Partial<WalletLedgerEntryState> = {}): WalletLedgerEntryState => ({
  id: 'e1',
  walletId: 'w1',
  transactionId: 't1',
  direction: LedgerDirection.Credit,
  money: brl('10.00'),
  balanceBefore: brl('5.00'),
  balanceAfter: brl('15.00'),
  walletVersion: 2,
  createdAt: new Date(0),
  ...overrides,
});

describe('WalletLedgerEntry.create', () => {
  it('creates a balanced credit', () => {
    const entry = WalletLedgerEntry.create(valid());
    expect(entry.isBalanced()).toBe(true);
    expect(entry.walletVersion).toBe(2);
  });

  it('creates a balanced debit', () => {
    const entry = WalletLedgerEntry.create(
      valid({
        direction: LedgerDirection.Debit,
        balanceBefore: brl('15.00'),
        balanceAfter: brl('5.00'),
      }),
    );
    expect(entry.isBalanced()).toBe(true);
  });

  it('rejects zero money', () => {
    expect(() =>
      WalletLedgerEntry.create(valid({ money: brl('0.00'), balanceAfter: brl('5.00') })),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  it('rejects mixed currencies', () => {
    expect(() =>
      WalletLedgerEntry.create(
        valid({ balanceBefore: Money.from({ amount: '5.00', currency: 'USD' }) }),
      ),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  it('rejects a negative balance before', () => {
    expect(() =>
      WalletLedgerEntry.create(
        valid({
          direction: LedgerDirection.Credit,
          balanceBefore: brl('0.00').subtract(brl('5.00')),
          balanceAfter: brl('5.00'),
        }),
      ),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  it('rejects a negative balance after', () => {
    expect(() =>
      WalletLedgerEntry.create(
        valid({
          direction: LedgerDirection.Debit,
          balanceBefore: brl('5.00'),
          balanceAfter: brl('5.00').subtract(brl('10.00')),
        }),
      ),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  it('rejects a credit that does not add up', () => {
    expect(() => WalletLedgerEntry.create(valid({ balanceAfter: brl('14.00') }))).toThrow(
      UnbalancedLedgerEntryError,
    );
  });

  it('rejects a debit that does not add up', () => {
    expect(() =>
      WalletLedgerEntry.create(
        valid({
          direction: LedgerDirection.Debit,
          balanceBefore: brl('15.00'),
          balanceAfter: brl('6.00'),
        }),
      ),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects wallet version %p', (walletVersion) => {
    expect(() => WalletLedgerEntry.create(valid({ walletVersion }))).toThrow(
      UnbalancedLedgerEntryError,
    );
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  it('does not validate and isBalanced reports false', () => {
    const entry = WalletLedgerEntry.rehydrate(valid({ balanceAfter: brl('99.00') }));
    expect(entry.isBalanced()).toBe(false);
  });

  it('reports false for mixed currencies', () => {
    const entry = WalletLedgerEntry.rehydrate(
      valid({ balanceAfter: Money.from({ amount: '15.00', currency: 'USD' }) }),
    );
    expect(entry.isBalanced()).toBe(false);
  });
});
