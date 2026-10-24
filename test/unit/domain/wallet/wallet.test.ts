import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError } from '@domain/shared/errors/currency-mismatch.error';
import { FailureCode } from '@domain/shared/failure-code';
import { Money } from '@domain/shared/money';
import { BalanceLimitExceededError } from '@domain/wallet/errors/balance-limit-exceeded.error';
import { InsufficientFundsError } from '@domain/wallet/errors/insufficient-funds.error';
import { InvalidAmountError } from '@domain/wallet/errors/invalid-amount.error';
import { LedgerDirection } from '@domain/wallet/ledger-direction';
import type { LedgerPosting } from '@domain/wallet/ledger-posting';
import { Wallet, type WalletMovementProps } from '@domain/wallet/wallet';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const fromCents = (cents: bigint): Money =>
  brl(`${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, '0')}`);

const openedAt = new Date('2026-01-01T00:00:00.000Z');
const movedAt = new Date('2026-01-02T00:00:00.000Z');

const openWallet = (initial: Money): { wallet: Wallet; posting: LedgerPosting | undefined } =>
  Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: initial,
    openingTransactionId: 'opening-1',
    fundingAccountId: 'funding-brl',
    walletEntryId: 'wallet-entry-0',
    houseEntryId: 'house-entry-0',
    now: openedAt,
  });

const movement = (money: Money, sequence = 1, now = movedAt): WalletMovementProps => ({
  transactionId: `tx-${String(sequence)}`,
  money,
  houseAccountId: 'gaming-brl',
  walletEntryId: `wallet-entry-${String(sequence)}`,
  houseEntryId: `house-entry-${String(sequence)}`,
  now,
});

const expectUnchanged = (wallet: Wallet, balance: Money, version: number, updatedAt: Date) => {
  expect(wallet.balance.equals(balance)).toBe(true);
  expect(wallet.version).toBe(version);
  expect(wallet.updatedAt).toEqual(updatedAt);
};

const captureFailureCode = (action: () => unknown): FailureCode | undefined => {
  try {
    action();
  } catch (error) {
    if (error instanceof InvalidAmountError) {
      return error.failureCode;
    }
    if (error instanceof CurrencyMismatchError) {
      return error.failureCode;
    }
    if (error instanceof InsufficientFundsError) {
      return error.failureCode;
    }
    if (error instanceof BalanceLimitExceededError) {
      return error.failureCode;
    }
    throw error;
  }
  return undefined;
};

describe('Wallet.open', () => {
  it('opens with zero balance, version 1 and no posting', () => {
    const { wallet, posting } = openWallet(brl('0.00'));
    expect(posting).toBeUndefined();
    expect(wallet.balance.equals(brl('0.00'))).toBe(true);
    expect(wallet.currency).toBe(brl('0.00').currency);
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt).toEqual(openedAt);
    expect(wallet.updatedAt).toEqual(openedAt);
    expect(wallet.id).toBe('wallet-1');
    expect(wallet.playerId).toBe('player-1');
  });

  it('opens with a positive balance and returns the opening posting', () => {
    const { wallet, posting } = openWallet(brl('150.25'));
    expect(wallet.balance.equals(brl('150.25'))).toBe(true);
    expect(wallet.version).toBe(1);
    expect(posting).toBeDefined();
    if (posting === undefined) {
      return;
    }
    const { walletEntry, houseEntry } = posting;
    expect(walletEntry.id).toBe('wallet-entry-0');
    expect(walletEntry.walletId).toBe('wallet-1');
    expect(walletEntry.transactionId).toBe('opening-1');
    expect(walletEntry.direction).toBe(LedgerDirection.Credit);
    expect(walletEntry.money.equals(brl('150.25'))).toBe(true);
    expect(walletEntry.balanceBefore.equals(brl('0.00'))).toBe(true);
    expect(walletEntry.balanceAfter.equals(brl('150.25'))).toBe(true);
    expect(walletEntry.walletVersion).toBe(1);
    expect(walletEntry.createdAt).toEqual(openedAt);
    expect(houseEntry.id).toBe('house-entry-0');
    expect(houseEntry.houseAccountId).toBe('funding-brl');
    expect(houseEntry.transactionId).toBe('opening-1');
    expect(houseEntry.direction).toBe(LedgerDirection.Debit);
    expect(houseEntry.money.equals(brl('150.25'))).toBe(true);
  });

  it('rejects a negative initial balance with INVALID_AMOUNT', () => {
    const negative = Money.fromSignedDecimal('-1.00', 'BRL');
    expect(() => openWallet(negative)).toThrow(InvalidAmountError);
    expect(captureFailureCode(() => openWallet(negative))).toBe(FailureCode.InvalidAmount);
  });
});

describe('Wallet.debit and Wallet.credit', () => {
  it('debits, bumps the version by 1 and returns a wallet DEBIT with a house CREDIT', () => {
    const { wallet } = openWallet(brl('100.00'));
    const posting = wallet.debit(movement(brl('30.00')));
    expect(wallet.balance.equals(brl('70.00'))).toBe(true);
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(movedAt);
    expect(posting.walletEntry.direction).toBe(LedgerDirection.Debit);
    expect(posting.walletEntry.balanceBefore.equals(brl('100.00'))).toBe(true);
    expect(posting.walletEntry.balanceAfter.equals(brl('70.00'))).toBe(true);
    expect(posting.walletEntry.walletVersion).toBe(2);
    expect(posting.walletEntry.transactionId).toBe('tx-1');
    expect(posting.houseEntry.direction).toBe(LedgerDirection.Credit);
    expect(posting.houseEntry.houseAccountId).toBe('gaming-brl');
    expect(posting.houseEntry.money.equals(brl('30.00'))).toBe(true);
  });

  it('credits, bumps the version by 1 and returns a wallet CREDIT with a house DEBIT', () => {
    const { wallet } = openWallet(brl('100.00'));
    wallet.debit(movement(brl('30.00'), 1));
    const posting = wallet.credit(movement(brl('5.50'), 2));
    expect(wallet.balance.equals(brl('75.50'))).toBe(true);
    expect(wallet.version).toBe(3);
    expect(posting.walletEntry.direction).toBe(LedgerDirection.Credit);
    expect(posting.walletEntry.balanceBefore.equals(brl('70.00'))).toBe(true);
    expect(posting.walletEntry.balanceAfter.equals(brl('75.50'))).toBe(true);
    expect(posting.walletEntry.walletVersion).toBe(3);
    expect(posting.houseEntry.direction).toBe(LedgerDirection.Debit);
    expect(posting.houseEntry.money.equals(brl('5.50'))).toBe(true);
  });

  it('debits the whole balance down to zero', () => {
    const { wallet } = openWallet(brl('10.00'));
    wallet.debit(movement(brl('10.00')));
    expect(wallet.balance.isZero()).toBe(true);
  });

  it('rejects an insufficient debit without changing balance, version or updatedAt', () => {
    const { wallet } = openWallet(brl('10.00'));
    expect(() => wallet.debit(movement(brl('10.01'), 1, movedAt))).toThrow(InsufficientFundsError);
    expect(captureFailureCode(() => wallet.debit(movement(brl('10.01'))))).toBe(
      FailureCode.InsufficientFunds,
    );
    expectUnchanged(wallet, brl('10.00'), 1, openedAt);
  });

  it('rejects money in another currency with CURRENCY_MISMATCH', () => {
    const { wallet } = openWallet(brl('10.00'));
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => wallet.debit(movement(usd))).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(movement(usd))).toThrow(CurrencyMismatchError);
    expect(captureFailureCode(() => wallet.credit(movement(usd)))).toBe(
      FailureCode.CurrencyMismatch,
    );
    expectUnchanged(wallet, brl('10.00'), 1, openedAt);
  });

  it('rejects a non-positive movement with INVALID_AMOUNT', () => {
    const { wallet } = openWallet(brl('10.00'));
    const negative = Money.fromSignedDecimal('-1.00', 'BRL');
    expect(() => wallet.debit(movement(brl('0.00')))).toThrow(InvalidAmountError);
    expect(() => wallet.credit(movement(brl('0.00')))).toThrow(InvalidAmountError);
    expect(() => wallet.debit(movement(negative))).toThrow(InvalidAmountError);
    expect(() => wallet.credit(movement(negative))).toThrow(InvalidAmountError);
    expect(captureFailureCode(() => wallet.credit(movement(brl('0.00'))))).toBe(
      FailureCode.InvalidAmount,
    );
    expectUnchanged(wallet, brl('10.00'), 1, openedAt);
  });

  it('rejects a credit above the storage limit with BALANCE_LIMIT_EXCEEDED', () => {
    const { wallet } = openWallet(brl('999999999999999999.99'));
    expect(() => wallet.credit(movement(brl('0.01')))).toThrow(BalanceLimitExceededError);
    expect(captureFailureCode(() => wallet.credit(movement(brl('0.01'))))).toBe(
      FailureCode.BalanceLimitExceeded,
    );
    expectUnchanged(wallet, brl('999999999999999999.99'), 1, openedAt);
  });

  it('keeps the balance after a credit up to the storage limit', () => {
    const { wallet } = openWallet(brl('999999999999999999.98'));
    wallet.credit(movement(brl('0.01')));
    expect(wallet.balance.equals(brl('999999999999999999.99'))).toBe(true);
    expect(wallet.version).toBe(2);
  });
});

describe('Wallet invariants', () => {
  it('keeps balance and version chain consistent over 200 random movements', () => {
    const modulus = 2n ** 64n;
    let seed = 20260101n;
    const nextRandom = (): bigint => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % modulus;
      return seed >> 33n;
    };

    const initial = brl('100.00');
    const { wallet, posting: opening } = openWallet(initial);
    expect(opening).toBeDefined();
    const postings: LedgerPosting[] = opening === undefined ? [] : [opening];

    let expectedCents = 10_000n;
    for (let step = 1; step <= 200; step += 1) {
      const cents = (nextRandom() % 50_000n) + 1n;
      const money = fromCents(cents);
      const now = new Date(movedAt.getTime() + step * 1000);
      const wantsDebit = nextRandom() % 2n === 0n;
      if (wantsDebit && cents <= expectedCents) {
        postings.push(wallet.debit(movement(money, step, now)));
        expectedCents -= cents;
      } else {
        postings.push(wallet.credit(movement(money, step, now)));
        expectedCents += cents;
      }
    }

    const movements = postings.slice(1);
    const sum = movements.reduce(
      (total, { walletEntry }) =>
        walletEntry.direction === LedgerDirection.Credit
          ? total.add(walletEntry.money)
          : total.subtract(walletEntry.money),
      initial,
    );
    expect(movements).toHaveLength(200);
    expect(wallet.balance.equals(sum)).toBe(true);
    expect(wallet.balance.equals(fromCents(expectedCents))).toBe(true);
    expect(wallet.version).toBe(201);

    postings.forEach((posting, index) => {
      expect(posting.walletEntry.walletVersion).toBe(index + 1);
      expect(posting.houseEntry.direction).not.toBe(posting.walletEntry.direction);
      const previous = postings[index - 1];
      if (previous === undefined) {
        expect(posting.walletEntry.balanceBefore.isZero()).toBe(true);
        return;
      }
      expect(posting.walletEntry.balanceBefore.equals(previous.walletEntry.balanceAfter)).toBe(
        true,
      );
    });
    const last = postings[postings.length - 1];
    expect(last?.walletEntry.balanceAfter.equals(wallet.balance)).toBe(true);
  });
});

describe('Wallet.rehydrate', () => {
  it('rebuilds persisted state without validating it', () => {
    const state = {
      id: 'wallet-9',
      playerId: 'player-9',
      currency: brl('0.00').currency,
      balance: Money.fromSignedDecimal('-5.00', 'BRL'),
      version: 0,
      createdAt: openedAt,
      updatedAt: movedAt,
    };
    const wallet = Wallet.rehydrate(state);
    expect(wallet.toState()).toEqual(state);
    expect(wallet.balance.isNegative()).toBe(true);
    expect(wallet.version).toBe(0);
  });

  it('round-trips toState after movements', () => {
    const { wallet } = openWallet(brl('20.00'));
    wallet.credit(movement(brl('1.00')));
    const copy = Wallet.rehydrate(wallet.toState());
    expect(copy.toState()).toEqual(wallet.toState());
    expect(copy.balance.equals(brl('21.00'))).toBe(true);
    expect(copy.version).toBe(2);
    expect(copy.updatedAt).toEqual(movedAt);
  });
});
