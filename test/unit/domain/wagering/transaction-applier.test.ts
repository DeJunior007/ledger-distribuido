import { describe, expect, it } from 'bun:test';
import { FailureCode } from '@domain/shared/failure-code';
import { Money } from '@domain/shared/money';
import { toCurrencyCode } from '@domain/shared/currency';
import { InvalidLedgerPostingError } from '@domain/wallet/errors/invalid-ledger-posting.error';
import { LedgerDirection } from '@domain/wallet/ledger-direction';
import type { LedgerPosting } from '@domain/wallet/ledger-posting';
import { Wallet } from '@domain/wallet/wallet';
import { decideReference, type ReferenceDecision } from '@domain/wagering/reference-policy';
import { TransactionApplier, type ApplyResult } from '@domain/wagering/transaction-applier';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '@domain/wagering/wager-transaction-status';
import {
  WagerTransaction,
  type CreateWagerTransactionProps,
} from '@domain/wagering/wager-transaction';

const brl = (amount: string): Money => Money.fromSignedDecimal(amount, 'BRL');
const usd = (amount: string): Money => Money.fromSignedDecimal(amount, 'USD');

const openedAt = new Date('2026-01-01T00:00:00.000Z');
const createdAt = new Date('2026-01-02T00:00:00.000Z');
const appliedAt = new Date('2026-01-03T00:00:00.000Z');

const GAMING_ACCOUNT_ID = 'gaming-brl';
const MAX_STORAGE_AMOUNT = '999999999999999999.99';

const applier = TransactionApplier.create();

const walletWith = (balance: Money, playerId = 'player-1'): Wallet =>
  Wallet.rehydrate({
    id: 'wallet-1',
    playerId,
    currency: toCurrencyCode('BRL'),
    balance,
    version: 3,
    createdAt: openedAt,
    updatedAt: openedAt,
  });

const transaction = (
  kind: WagerTransactionKind,
  money: Money,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction =>
  WagerTransaction.create({
    id: `tx-${kind.toLowerCase()}`,
    providerId: 'provider-1',
    externalTransactionId: `ext-${kind.toLowerCase()}`,
    idempotencyKey: `key-${kind.toLowerCase()}`,
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money,
    referenceExternalTransactionId: undefined,
    correlationId: 'corr-1',
    now: createdAt,
    ...overrides,
  });

const processedReference = (kind: WagerTransactionKind, money: Money): WagerTransaction => {
  const base = transaction(kind, money, {
    id: `ref-${kind.toLowerCase()}`,
    externalTransactionId: `ext-ref-${kind.toLowerCase()}`,
    idempotencyKey: `key-ref-${kind.toLowerCase()}`,
    referenceExternalTransactionId: kind === WagerTransactionKind.Bet ? undefined : 'ext-ref-bet',
  });
  return WagerTransaction.rehydrate({
    ...base.toState(),
    status: WagerTransactionStatus.Processed,
    referenceTransactionId: kind === WagerTransactionKind.Bet ? undefined : 'ref-bet',
    balanceSnapshot: brl('0.00'),
    processedAt: createdAt,
  });
};

const referencing = (
  kind: WagerTransactionKind,
  money: Money,
  reference: WagerTransaction,
): WagerTransaction =>
  transaction(kind, money, { referenceExternalTransactionId: reference.externalTransactionId });

const decide = (tx: WagerTransaction, reference: WagerTransaction | undefined): ReferenceDecision =>
  decideReference({ transaction: tx, reference, referenceAlreadyReversed: false });

interface Applied {
  result: ApplyResult;
  posting: LedgerPosting | undefined;
}

const applyTo = (
  wallet: Wallet,
  tx: WagerTransaction,
  reference: WagerTransaction | undefined,
  decision: ReferenceDecision = decide(tx, reference),
  sequence = 1,
): Applied => {
  const result = applier.apply({
    wallet,
    transaction: tx,
    reference,
    decision,
    gamingAccountId: GAMING_ACCOUNT_ID,
    walletEntryId: `wallet-entry-${String(sequence)}`,
    houseEntryId: `house-entry-${String(sequence)}`,
    now: appliedAt,
  });
  return { result, posting: result.outcome === 'PROCESSED' ? result.posting : undefined };
};

const signedAmountOf = (posting: LedgerPosting): Money =>
  posting.walletEntry.direction === LedgerDirection.Credit
    ? posting.walletEntry.money
    : posting.walletEntry.money.negate();

const expectBalanceMatchesPostings = (
  initial: Money,
  wallet: Wallet,
  postings: readonly (LedgerPosting | undefined)[],
): void => {
  const expected = postings.reduce<Money>(
    (total, posting) => (posting === undefined ? total : total.add(signedAmountOf(posting))),
    initial,
  );
  expect(wallet.balance.equals(expected)).toBe(true);
};

const expectProcessed = (
  applied: Applied,
  tx: WagerTransaction,
  wallet: Wallet,
  referenceTransactionId: string | undefined,
): void => {
  expect(applied.result.outcome).toBe('PROCESSED');
  expect(tx.status).toBe(WagerTransactionStatus.Processed);
  expect(tx.failureCode).toBeUndefined();
  expect(tx.referenceTransactionId).toBe(referenceTransactionId);
  expect(tx.processedAt).toEqual(appliedAt);
  expect(tx.updatedAt).toEqual(appliedAt);
  expect(tx.balanceSnapshot?.equals(wallet.balance)).toBe(true);
};

const expectRejected = (
  result: ApplyResult | undefined,
  tx: WagerTransaction,
  wallet: Wallet,
  failureCode: FailureCode,
): void => {
  expect(result).toEqual({ outcome: 'REJECTED', failureCode });
  expect(tx.status).toBe(WagerTransactionStatus.Rejected);
  expect(tx.failureCode).toBe(failureCode);
  expect(tx.processedAt).toBeUndefined();
  expect(tx.updatedAt).toEqual(appliedAt);
  expect(tx.balanceSnapshot?.equals(wallet.balance)).toBe(true);
};

const expectPosting = (
  posting: LedgerPosting | undefined,
  tx: WagerTransaction,
  direction: LedgerDirection,
  balanceBefore: Money,
  balanceAfter: Money,
): void => {
  expect(posting).toBeDefined();
  if (posting === undefined) {
    return;
  }
  expect(posting.walletEntry.direction).toBe(direction);
  expect(posting.walletEntry.transactionId).toBe(tx.id);
  expect(posting.walletEntry.walletId).toBe('wallet-1');
  expect(posting.walletEntry.money.equals(tx.money)).toBe(true);
  expect(posting.walletEntry.balanceBefore.equals(balanceBefore)).toBe(true);
  expect(posting.walletEntry.balanceAfter.equals(balanceAfter)).toBe(true);
  expect(posting.walletEntry.walletVersion).toBe(4);
  expect(posting.walletEntry.id).toBe('wallet-entry-1');
  expect(posting.houseEntry.id).toBe('house-entry-1');
  expect(posting.houseEntry.houseAccountId).toBe(GAMING_ACCOUNT_ID);
  expect(posting.houseEntry.transactionId).toBe(tx.id);
  expect(posting.houseEntry.money.equals(tx.money)).toBe(true);
  expect(posting.houseEntry.direction).not.toBe(direction);
};

const expectWalletUntouched = (wallet: Wallet, balance: Money): void => {
  expect(wallet.balance.equals(balance)).toBe(true);
  expect(wallet.version).toBe(3);
  expect(wallet.updatedAt).toEqual(openedAt);
};

describe('TransactionApplier.checkContext', () => {
  it('returns undefined and leaves the transaction pending when the context matches', () => {
    const initial = brl('100.00');
    const wallet = walletWith(initial);
    const tx = transaction(WagerTransactionKind.Bet, brl('10.00'));
    expect(applier.checkContext({ wallet, transaction: tx, now: appliedAt })).toBeUndefined();
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.balanceSnapshot).toBeUndefined();
    expectWalletUntouched(wallet, initial);
    expectBalanceMatchesPostings(initial, wallet, []);
  });

  it('rejects with PLAYER_WALLET_MISMATCH when the player differs from the wallet owner', () => {
    const initial = brl('100.00');
    const wallet = walletWith(initial, 'player-2');
    const tx = transaction(WagerTransactionKind.Bet, brl('10.00'));
    const result = applier.checkContext({ wallet, transaction: tx, now: appliedAt });
    expectRejected(result, tx, wallet, FailureCode.PlayerWalletMismatch);
    expect(tx.referenceTransactionId).toBeUndefined();
    expectWalletUntouched(wallet, initial);
    expectBalanceMatchesPostings(initial, wallet, []);
  });

  it('rejects with CURRENCY_MISMATCH and keeps the snapshot in the wallet currency', () => {
    const initial = brl('100.00');
    const wallet = walletWith(initial);
    const tx = transaction(WagerTransactionKind.Bet, usd('10.00'));
    const result = applier.checkContext({ wallet, transaction: tx, now: appliedAt });
    expectRejected(result, tx, wallet, FailureCode.CurrencyMismatch);
    expect(tx.balanceSnapshot?.currency).toBe(wallet.currency);
    expect(tx.balanceSnapshot?.equals(initial)).toBe(true);
    expectWalletUntouched(wallet, initial);
    expectBalanceMatchesPostings(initial, wallet, []);
  });

  it('checks the player before the currency', () => {
    const initial = brl('100.00');
    const wallet = walletWith(initial, 'player-2');
    const tx = transaction(WagerTransactionKind.Bet, usd('10.00'));
    expect(applier.checkContext({ wallet, transaction: tx, now: appliedAt })).toEqual({
      outcome: 'REJECTED',
      failureCode: FailureCode.PlayerWalletMismatch,
    });
    expect(tx.balanceSnapshot?.currency).toBe(wallet.currency);
    expectBalanceMatchesPostings(initial, wallet, []);
  });
});

describe('TransactionApplier.apply with WAIT and REJECT', () => {
  it('moves the transaction to PENDING_REFERENCE with the current balance on WAIT', () => {
    const initial = brl('100.00');
    const wallet = walletWith(initial);
    const tx = transaction(WagerTransactionKind.Win, brl('10.00'), {
      referenceExternalTransactionId: 'ext-missing',
    });
    const applied = applyTo(wallet, tx, undefined);
    expect(applied.result).toEqual({ outcome: 'PENDING_REFERENCE' });
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.balanceSnapshot?.equals(initial)).toBe(true);
    expect(tx.updatedAt).toEqual(appliedAt);
    expectWalletUntouched(wallet, initial);
    expectBalanceMatchesPostings(initial, wallet, [applied.posting]);
  });

  it('rejects with the decision code and reference on REJECT without touching the wallet', () => {
    const initial = brl('100.00');
    const wallet = walletWith(initial);
    const tx = transaction(WagerTransactionKind.Refund, brl('10.00'), {
      referenceExternalTransactionId: 'ext-ref-bet',
    });
    const applied = applyTo(wallet, tx, undefined, {
      type: 'REJECT',
      failureCode: FailureCode.AmountMismatch,
      referenceTransactionId: 'ref-bet',
    });
    expectRejected(applied.result, tx, wallet, FailureCode.AmountMismatch);
    expect(tx.referenceTransactionId).toBe('ref-bet');
    expectWalletUntouched(wallet, initial);
    expectBalanceMatchesPostings(initial, wallet, [applied.posting]);
  });
});

describe('TransactionApplier.apply with APPLY', () => {
  it('debits a BET when the balance is enough', () => {
    const initial = brl('100.00');
    const wallet = walletWith(initial);
    const tx = transaction(WagerTransactionKind.Bet, brl('30.00'));
    const applied = applyTo(wallet, tx, undefined);
    expectProcessed(applied, tx, wallet, undefined);
    expectPosting(applied.posting, tx, LedgerDirection.Debit, initial, brl('70.00'));
    expect(wallet.balance.equals(brl('70.00'))).toBe(true);
    expect(wallet.version).toBe(4);
    expect(wallet.updatedAt).toEqual(appliedAt);
    expectBalanceMatchesPostings(initial, wallet, [applied.posting]);
  });

  it('rejects a BET with INSUFFICIENT_FUNDS when the balance is not enough', () => {
    const initial = brl('20.00');
    const wallet = walletWith(initial);
    const tx = transaction(WagerTransactionKind.Bet, brl('30.00'));
    const applied = applyTo(wallet, tx, undefined);
    expectRejected(applied.result, tx, wallet, FailureCode.InsufficientFunds);
    expectWalletUntouched(wallet, initial);
    expectBalanceMatchesPostings(initial, wallet, [applied.posting]);
  });

  it('credits a WIN that references a processed BET', () => {
    const initial = brl('100.00');
    const wallet = walletWith(initial);
    const bet = processedReference(WagerTransactionKind.Bet, brl('30.00'));
    const tx = referencing(WagerTransactionKind.Win, brl('50.00'), bet);
    const applied = applyTo(wallet, tx, bet);
    expectProcessed(applied, tx, wallet, bet.id);
    expectPosting(applied.posting, tx, LedgerDirection.Credit, initial, brl('150.00'));
    expectBalanceMatchesPostings(initial, wallet, [applied.posting]);
  });

  it('credits a WIN without reference', () => {
    const initial = brl('100.00');
    const wallet = walletWith(initial);
    const tx = transaction(WagerTransactionKind.Win, brl('5.00'));
    const applied = applyTo(wallet, tx, undefined);
    expectProcessed(applied, tx, wallet, undefined);
    expectPosting(applied.posting, tx, LedgerDirection.Credit, initial, brl('105.00'));
    expectBalanceMatchesPostings(initial, wallet, [applied.posting]);
  });

  it('processes a LOSS without posting and without touching the wallet', () => {
    const initial = brl('100.00');
    const wallet = walletWith(initial);
    const bet = processedReference(WagerTransactionKind.Bet, brl('30.00'));
    const tx = referencing(WagerTransactionKind.Loss, brl('30.00'), bet);
    const applied = applyTo(wallet, tx, bet);
    expect(applied.result).toEqual({ outcome: 'PROCESSED', posting: undefined });
    expectProcessed(applied, tx, wallet, bet.id);
    expect(tx.balanceSnapshot?.equals(initial)).toBe(true);
    expectWalletUntouched(wallet, initial);
    expectBalanceMatchesPostings(initial, wallet, [applied.posting]);
  });

  it('processes a zero LOSS without posting', () => {
    const initial = brl('0.00');
    const wallet = walletWith(initial);
    const tx = transaction(WagerTransactionKind.Loss, brl('0.00'));
    const applied = applyTo(wallet, tx, undefined);
    expect(applied.result).toEqual({ outcome: 'PROCESSED', posting: undefined });
    expectProcessed(applied, tx, wallet, undefined);
    expectWalletUntouched(wallet, initial);
    expectBalanceMatchesPostings(initial, wallet, [applied.posting]);
  });

  it('credits a REFUND of a processed BET', () => {
    const initial = brl('70.00');
    const wallet = walletWith(initial);
    const bet = processedReference(WagerTransactionKind.Bet, brl('30.00'));
    const tx = referencing(WagerTransactionKind.Refund, brl('30.00'), bet);
    const applied = applyTo(wallet, tx, bet);
    expectProcessed(applied, tx, wallet, bet.id);
    expectPosting(applied.posting, tx, LedgerDirection.Credit, initial, brl('100.00'));
    expectBalanceMatchesPostings(initial, wallet, [applied.posting]);
  });

  it('credits a ROLLBACK of a BET', () => {
    const initial = brl('70.00');
    const wallet = walletWith(initial);
    const bet = processedReference(WagerTransactionKind.Bet, brl('30.00'));
    const tx = referencing(WagerTransactionKind.Rollback, brl('30.00'), bet);
    const applied = applyTo(wallet, tx, bet);
    expectProcessed(applied, tx, wallet, bet.id);
    expectPosting(applied.posting, tx, LedgerDirection.Credit, initial, brl('100.00'));
    expectBalanceMatchesPostings(initial, wallet, [applied.posting]);
  });

  it('debits a ROLLBACK of a WIN', () => {
    const initial = brl('150.00');
    const wallet = walletWith(initial);
    const win = processedReference(WagerTransactionKind.Win, brl('50.00'));
    const tx = referencing(WagerTransactionKind.Rollback, brl('50.00'), win);
    const applied = applyTo(wallet, tx, win);
    expectProcessed(applied, tx, wallet, win.id);
    expectPosting(applied.posting, tx, LedgerDirection.Debit, initial, brl('100.00'));
    expectBalanceMatchesPostings(initial, wallet, [applied.posting]);
  });

  it('debits a ROLLBACK of a REFUND', () => {
    const initial = brl('100.00');
    const wallet = walletWith(initial);
    const refund = processedReference(WagerTransactionKind.Refund, brl('30.00'));
    const tx = referencing(WagerTransactionKind.Rollback, brl('30.00'), refund);
    const applied = applyTo(wallet, tx, refund);
    expectProcessed(applied, tx, wallet, refund.id);
    expectPosting(applied.posting, tx, LedgerDirection.Debit, initial, brl('70.00'));
    expectBalanceMatchesPostings(initial, wallet, [applied.posting]);
  });

  it('rejects a ROLLBACK of a WIN with INSUFFICIENT_FUNDS_FOR_REVERSAL when the balance is short', () => {
    const initial = brl('20.00');
    const wallet = walletWith(initial);
    const win = processedReference(WagerTransactionKind.Win, brl('50.00'));
    const tx = referencing(WagerTransactionKind.Rollback, brl('50.00'), win);
    const applied = applyTo(wallet, tx, win);
    expectRejected(applied.result, tx, wallet, FailureCode.InsufficientFundsForReversal);
    expect(tx.referenceTransactionId).toBe(win.id);
    expectWalletUntouched(wallet, initial);
    expectBalanceMatchesPostings(initial, wallet, [applied.posting]);
  });

  it('rejects a ROLLBACK of a REFUND with INSUFFICIENT_FUNDS_FOR_REVERSAL when the balance is short', () => {
    const initial = brl('10.00');
    const wallet = walletWith(initial);
    const refund = processedReference(WagerTransactionKind.Refund, brl('30.00'));
    const tx = referencing(WagerTransactionKind.Rollback, brl('30.00'), refund);
    const applied = applyTo(wallet, tx, refund);
    expectRejected(applied.result, tx, wallet, FailureCode.InsufficientFundsForReversal);
    expectWalletUntouched(wallet, initial);
    expectBalanceMatchesPostings(initial, wallet, [applied.posting]);
  });

  it('rejects a credit above the storage limit with BALANCE_LIMIT_EXCEEDED', () => {
    const initial = brl(MAX_STORAGE_AMOUNT);
    const wallet = walletWith(initial);
    const tx = transaction(WagerTransactionKind.Win, brl('0.01'));
    const applied = applyTo(wallet, tx, undefined);
    expectRejected(applied.result, tx, wallet, FailureCode.BalanceLimitExceeded);
    expectWalletUntouched(wallet, initial);
    expectBalanceMatchesPostings(initial, wallet, [applied.posting]);
  });

  it('credits up to the storage limit', () => {
    const initial = brl('999999999999999999.98');
    const wallet = walletWith(initial);
    const tx = transaction(WagerTransactionKind.Win, brl('0.01'));
    const applied = applyTo(wallet, tx, undefined);
    expectProcessed(applied, tx, wallet, undefined);
    expect(wallet.balance.equals(brl(MAX_STORAGE_AMOUNT))).toBe(true);
    expectBalanceMatchesPostings(initial, wallet, [applied.posting]);
  });

  it('resolves a transaction that was waiting for its reference', () => {
    const initial = brl('100.00');
    const wallet = walletWith(initial);
    const bet = processedReference(WagerTransactionKind.Bet, brl('30.00'));
    const tx = referencing(WagerTransactionKind.Win, brl('40.00'), bet);
    const waited = applyTo(wallet, tx, undefined);
    expect(waited.result).toEqual({ outcome: 'PENDING_REFERENCE' });
    const applied = applyTo(wallet, tx, bet);
    expectProcessed(applied, tx, wallet, bet.id);
    expectPosting(applied.posting, tx, LedgerDirection.Credit, initial, brl('140.00'));
    expectBalanceMatchesPostings(initial, wallet, [waited.posting, applied.posting]);
  });

  it('propagates errors that are not balance rules', () => {
    const initial = brl('100.00');
    const wallet = walletWith(initial);
    const tx = transaction(WagerTransactionKind.Rollback, brl('10.00'), {
      referenceExternalTransactionId: 'ext-ref-bet',
    });
    expect(() =>
      applyTo(wallet, tx, undefined, { type: 'APPLY', referenceTransactionId: 'ref-bet' }),
    ).toThrow(InvalidLedgerPostingError);
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expectWalletUntouched(wallet, initial);
    expectBalanceMatchesPostings(initial, wallet, []);
  });
});

describe('TransactionApplier serial scenario', () => {
  it('processes one of two 80.00 bets on a 100.00 wallet and leaves 20.00', () => {
    const initial = brl('100.00');
    const wallet = walletWith(initial);
    const first = transaction(WagerTransactionKind.Bet, brl('80.00'), {
      id: 'tx-bet-1',
      externalTransactionId: 'ext-bet-1',
      idempotencyKey: 'key-bet-1',
    });
    const second = transaction(WagerTransactionKind.Bet, brl('80.00'), {
      id: 'tx-bet-2',
      externalTransactionId: 'ext-bet-2',
      idempotencyKey: 'key-bet-2',
    });
    const firstApplied = applyTo(wallet, first, undefined, decide(first, undefined), 1);
    const secondApplied = applyTo(wallet, second, undefined, decide(second, undefined), 2);
    const outcomes = [firstApplied.result, secondApplied.result];
    expect(outcomes.filter((result) => result.outcome === 'PROCESSED')).toHaveLength(1);
    expect(outcomes).toContainEqual({
      outcome: 'REJECTED',
      failureCode: FailureCode.InsufficientFunds,
    });
    expect(first.status).toBe(WagerTransactionStatus.Processed);
    expect(second.status).toBe(WagerTransactionStatus.Rejected);
    expect(second.balanceSnapshot?.equals(brl('20.00'))).toBe(true);
    expect(wallet.balance.equals(brl('20.00'))).toBe(true);
    expect(wallet.version).toBe(4);
    expectBalanceMatchesPostings(initial, wallet, [firstApplied.posting, secondApplied.posting]);
  });
});
