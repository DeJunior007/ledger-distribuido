import { describe, expect, it } from 'bun:test';
import { Money } from '@domain/shared/money';
import { InvalidLedgerPostingError } from '@domain/wallet/errors/invalid-ledger-posting.error';
import { UnbalancedLedgerEntryError } from '@domain/wallet/errors/unbalanced-ledger-entry.error';
import { HouseLedgerEntry } from '@domain/wallet/house-ledger-entry';
import { LedgerDirection } from '@domain/wallet/ledger-direction';
import { LedgerPosting } from '@domain/wallet/ledger-posting';
import { WalletLedgerEntry } from '@domain/wallet/wallet-ledger-entry';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const walletEntry = (transactionId = 't1', money = brl('10.00')): WalletLedgerEntry =>
  WalletLedgerEntry.create({
    id: 'e1',
    walletId: 'w1',
    transactionId,
    direction: LedgerDirection.Credit,
    money,
    balanceBefore: brl('0.00'),
    balanceAfter: money,
    walletVersion: 1,
    createdAt: new Date(0),
  });

const houseEntry = (
  direction = LedgerDirection.Debit,
  transactionId = 't1',
  money = brl('10.00'),
): HouseLedgerEntry =>
  HouseLedgerEntry.create({
    id: 'h1',
    houseAccountId: 'a1',
    transactionId,
    direction,
    money,
    createdAt: new Date(0),
  });

describe('LedgerPosting.create', () => {
  it('pairs opposite entries of the same money and transaction', () => {
    const wallet = walletEntry();
    const house = houseEntry();
    const posting = LedgerPosting.create({ walletEntry: wallet, houseEntry: house });
    expect(posting.walletEntry).toBe(wallet);
    expect(posting.houseEntry).toBe(house);
  });

  it('rejects equal directions', () => {
    expect(() =>
      LedgerPosting.create({
        walletEntry: walletEntry(),
        houseEntry: houseEntry(LedgerDirection.Credit),
      }),
    ).toThrow(InvalidLedgerPostingError);
  });

  it('rejects different money', () => {
    expect(() =>
      LedgerPosting.create({
        walletEntry: walletEntry(),
        houseEntry: houseEntry(LedgerDirection.Debit, 't1', brl('11.00')),
      }),
    ).toThrow(InvalidLedgerPostingError);
  });

  it('rejects different transactions', () => {
    expect(() =>
      LedgerPosting.create({
        walletEntry: walletEntry(),
        houseEntry: houseEntry(LedgerDirection.Debit, 't2'),
      }),
    ).toThrow(InvalidLedgerPostingError);
  });
});

describe('HouseLedgerEntry.create', () => {
  it('rejects non-positive money', () => {
    expect(() => houseEntry(LedgerDirection.Debit, 't1', brl('0.00'))).toThrow(
      UnbalancedLedgerEntryError,
    );
  });
});
