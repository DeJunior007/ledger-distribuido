import { describe, expect, it } from 'bun:test';
import { toCurrencyCode } from '@domain/shared/currency';
import { InvalidLedgerPostingError } from '@domain/wallet/errors/invalid-ledger-posting.error';
import {
  HouseAccount,
  HouseAccountPurpose,
  houseAccountPurposeFor,
} from '@domain/wallet/house-account';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';

describe('houseAccountPurposeFor', () => {
  it.each([
    [WagerTransactionKind.Opening, HouseAccountPurpose.Funding],
    [WagerTransactionKind.Bet, HouseAccountPurpose.Gaming],
    [WagerTransactionKind.Win, HouseAccountPurpose.Gaming],
    [WagerTransactionKind.Refund, HouseAccountPurpose.Gaming],
    [WagerTransactionKind.Rollback, HouseAccountPurpose.Gaming],
  ])('maps %s to %s', (kind, purpose) => {
    expect(houseAccountPurposeFor(kind)).toBe(purpose);
  });

  it('throws for a loss', () => {
    expect(() => houseAccountPurposeFor(WagerTransactionKind.Loss)).toThrow(
      InvalidLedgerPostingError,
    );
  });
});

describe('HouseAccount', () => {
  const state = {
    id: 'h1',
    currency: toCurrencyCode('BRL'),
    purpose: HouseAccountPurpose.Gaming,
    createdAt: new Date(0),
  };

  it('creates and rehydrates with the given state', () => {
    expect(HouseAccount.create(state)).toMatchObject(state);
    expect(HouseAccount.rehydrate(state)).toMatchObject(state);
  });
});
