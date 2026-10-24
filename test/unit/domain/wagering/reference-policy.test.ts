import { describe, expect, it } from 'bun:test';
import { FailureCode } from '@domain/shared/failure-code';
import { Money } from '@domain/shared/money';
import { decideReference } from '@domain/wagering/reference-policy';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '@domain/wagering/wager-transaction-status';
import {
  WagerTransaction,
  type CreateWagerTransactionProps,
} from '@domain/wagering/wager-transaction';

const brl = (amount: string): Money => Money.fromSignedDecimal(amount, 'BRL');
const now = new Date('2026-01-01T00:00:00.000Z');

const build = (
  kind: WagerTransactionKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction =>
  WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-1',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'key-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl('10.00'),
    referenceExternalTransactionId: kind === WagerTransactionKind.Bet ? undefined : 'ext-ref',
    correlationId: 'corr-1',
    now,
    ...overrides,
  });

const buildReference = (
  kind: WagerTransactionKind,
  status: WagerTransactionStatus = WagerTransactionStatus.Processed,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction =>
  WagerTransaction.rehydrate({
    ...build(kind, {
      id: 'ref-1',
      externalTransactionId: 'ext-ref',
      idempotencyKey: 'key-ref',
      referenceExternalTransactionId:
        kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback
          ? 'ext-origin'
          : undefined,
      ...overrides,
    }).toState(),
    status,
  });

const decide = (
  transaction: WagerTransaction,
  reference: WagerTransaction | undefined,
  referenceAlreadyReversed = false,
): ReturnType<typeof decideReference> =>
  decideReference({ transaction, reference, referenceAlreadyReversed });

const bet = (): WagerTransaction => buildReference(WagerTransactionKind.Bet);

describe('decideReference', () => {
  it('applies without reference when the transaction has no reference id', () => {
    expect(decide(build(WagerTransactionKind.Bet), undefined)).toEqual({
      type: 'APPLY',
      referenceTransactionId: undefined,
    });
    expect(
      decide(
        build(WagerTransactionKind.Win, { referenceExternalTransactionId: undefined }),
        undefined,
      ),
    ).toEqual({ type: 'APPLY', referenceTransactionId: undefined });
  });

  it('waits when the reference is absent (row 1)', () => {
    expect(decide(build(WagerTransactionKind.Win), undefined)).toEqual({ type: 'WAIT' });
  });

  it('waits when the reference is pending reference (row 2)', () => {
    const reference = buildReference(
      WagerTransactionKind.Bet,
      WagerTransactionStatus.PendingReference,
    );
    expect(decide(build(WagerTransactionKind.Win), reference)).toEqual({ type: 'WAIT' });
  });

  it('rejects when the reference was rejected or failed (row 3)', () => {
    for (const status of [WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed]) {
      const reference = buildReference(WagerTransactionKind.Bet, status);
      expect(decide(build(WagerTransactionKind.Win), reference)).toEqual({
        type: 'REJECT',
        failureCode: FailureCode.ReferenceNotProcessed,
        referenceTransactionId: 'ref-1',
      });
    }
  });

  it('rejects when identity fields differ (row 4)', () => {
    const cases: Partial<CreateWagerTransactionProps>[] = [
      { providerId: 'other' },
      { playerId: 'other' },
      { walletId: 'other' },
      { roundId: 'other' },
      { money: Money.fromSignedDecimal('10.00', 'USD') },
    ];
    for (const override of cases) {
      const reference = buildReference(WagerTransactionKind.Bet, undefined, override);
      expect(decide(build(WagerTransactionKind.Win), reference)).toEqual({
        type: 'REJECT',
        failureCode: FailureCode.ReferenceMismatch,
        referenceTransactionId: 'ref-1',
      });
    }
  });

  it('rejects invalid reference kinds (row 5)', () => {
    const cases: [WagerTransactionKind, WagerTransactionKind][] = [
      [WagerTransactionKind.Refund, WagerTransactionKind.Win],
      [WagerTransactionKind.Rollback, WagerTransactionKind.Loss],
      [WagerTransactionKind.Rollback, WagerTransactionKind.Rollback],
      [WagerTransactionKind.Win, WagerTransactionKind.Win],
      [WagerTransactionKind.Loss, WagerTransactionKind.Refund],
    ];
    for (const [kind, referenceKind] of cases) {
      const reference = buildReference(referenceKind);
      expect(decide(build(kind), reference)).toEqual({
        type: 'REJECT',
        failureCode: FailureCode.InvalidReferenceKind,
        referenceTransactionId: 'ref-1',
      });
    }
  });

  it('accepts rollback referencing BET, WIN or REFUND', () => {
    for (const referenceKind of [
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Refund,
    ]) {
      expect(decide(build(WagerTransactionKind.Rollback), buildReference(referenceKind))).toEqual({
        type: 'APPLY',
        referenceTransactionId: 'ref-1',
      });
    }
  });

  it('rejects reversals with a different amount (row 6)', () => {
    for (const kind of [WagerTransactionKind.Refund, WagerTransactionKind.Rollback]) {
      const reference = buildReference(WagerTransactionKind.Bet, undefined, {
        money: brl('11.00'),
      });
      expect(decide(build(kind), reference)).toEqual({
        type: 'REJECT',
        failureCode: FailureCode.AmountMismatch,
        referenceTransactionId: 'ref-1',
      });
    }
  });

  it('rejects reversals of an already reversed reference (row 7)', () => {
    for (const kind of [WagerTransactionKind.Refund, WagerTransactionKind.Rollback]) {
      expect(decide(build(kind), bet(), true)).toEqual({
        type: 'REJECT',
        failureCode: FailureCode.ReferenceAlreadyReversed,
        referenceTransactionId: 'ref-1',
      });
    }
  });

  it('rejects a WIN over a reversed BET (row 7)', () => {
    expect(decide(build(WagerTransactionKind.Win), bet(), true)).toEqual({
      type: 'REJECT',
      failureCode: FailureCode.ReferenceAlreadyReversed,
      referenceTransactionId: 'ref-1',
    });
  });

  it('applies a LOSS over a reversed BET', () => {
    expect(decide(build(WagerTransactionKind.Loss), bet(), true)).toEqual({
      type: 'APPLY',
      referenceTransactionId: 'ref-1',
    });
  });

  it('applies the rest carrying the reference id (row 8)', () => {
    expect(decide(build(WagerTransactionKind.Win), bet())).toEqual({
      type: 'APPLY',
      referenceTransactionId: 'ref-1',
    });
    expect(decide(build(WagerTransactionKind.Refund), bet())).toEqual({
      type: 'APPLY',
      referenceTransactionId: 'ref-1',
    });
  });

  it('checks the mismatch row before the amount row', () => {
    const reference = buildReference(WagerTransactionKind.Bet, undefined, {
      roundId: 'other',
      money: brl('11.00'),
    });
    expect(decide(build(WagerTransactionKind.Refund), reference)).toMatchObject({
      failureCode: FailureCode.ReferenceMismatch,
    });
  });

  it('checks the kind row before the amount row and the amount row before reversed', () => {
    const win = buildReference(WagerTransactionKind.Win, undefined, { money: brl('11.00') });
    expect(decide(build(WagerTransactionKind.Refund), win, true)).toMatchObject({
      failureCode: FailureCode.InvalidReferenceKind,
    });
    const bigBet = buildReference(WagerTransactionKind.Bet, undefined, { money: brl('11.00') });
    expect(decide(build(WagerTransactionKind.Refund), bigBet, true)).toMatchObject({
      failureCode: FailureCode.AmountMismatch,
    });
  });
});
