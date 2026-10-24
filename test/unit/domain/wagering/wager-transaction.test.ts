import { describe, expect, it } from 'bun:test';
import { FailureCode, PERSISTED_REJECTION_CODES } from '@domain/shared/failure-code';
import { Money } from '@domain/shared/money';
import { InvalidAmountError } from '@domain/wallet/errors/invalid-amount.error';
import { InvalidLedgerPostingError } from '@domain/wallet/errors/invalid-ledger-posting.error';
import { LedgerDirection } from '@domain/wallet/ledger-direction';
import { InvalidPayloadError } from '@domain/wagering/errors/invalid-payload.error';
import { InvalidTransactionStateError } from '@domain/wagering/errors/invalid-transaction-state.error';
import { ReferenceRequiredError } from '@domain/wagering/errors/reference-required.error';
import { UnsupportedKindError } from '@domain/wagering/errors/unsupported-kind.error';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '@domain/wagering/wager-transaction-status';
import {
  WagerTransaction,
  type CreateWagerTransactionProps,
} from '@domain/wagering/wager-transaction';

const brl = (amount: string): Money => Money.fromSignedDecimal(amount, 'BRL');
const createdAt = new Date('2026-01-01T00:00:00.000Z');
const later = new Date('2026-01-02T00:00:00.000Z');

const props = (
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps => ({
  id: 'tx-1',
  providerId: 'provider-1',
  externalTransactionId: 'ext-1',
  idempotencyKey: 'key-1',
  payloadHash: 'hash-1',
  walletId: 'wallet-1',
  playerId: 'player-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: WagerTransactionKind.Bet,
  money: brl('10.00'),
  referenceExternalTransactionId: undefined,
  correlationId: 'corr-1',
  now: createdAt,
  ...overrides,
});

const withKind = (
  kind: WagerTransactionKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction =>
  WagerTransaction.create(
    props({
      kind,
      referenceExternalTransactionId: kind === WagerTransactionKind.Bet ? undefined : 'ext-ref',
      ...overrides,
    }),
  );

const inStatus = (status: WagerTransactionStatus): WagerTransaction =>
  WagerTransaction.rehydrate({
    ...WagerTransaction.create(props()).toState(),
    status,
  });

const allStatuses = Object.values(WagerTransactionStatus);
const snapshot = brl('5.00');

describe('WagerTransaction.create', () => {
  it('creates a pending transaction', () => {
    const tx = WagerTransaction.create(props());
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.failureCode).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.balanceSnapshot).toBeUndefined();
    expect(tx.isTerminal()).toBe(false);
  });

  it('rejects the OPENING kind', () => {
    const act = (): WagerTransaction =>
      WagerTransaction.create(props({ kind: WagerTransactionKind.Opening }));
    expect(act).toThrow(UnsupportedKindError);
    try {
      act();
    } catch (error) {
      expect(error).toHaveProperty('failureCode', FailureCode.UnsupportedKind);
    }
  });

  it('rejects the system provider', () => {
    const act = (): WagerTransaction =>
      WagerTransaction.create(props({ providerId: '__system__' }));
    expect(act).toThrow(InvalidPayloadError);
  });

  it('requires a reference for REFUND and ROLLBACK', () => {
    for (const kind of [WagerTransactionKind.Refund, WagerTransactionKind.Rollback]) {
      const act = (): WagerTransaction => WagerTransaction.create(props({ kind }));
      expect(act).toThrow(ReferenceRequiredError);
    }
  });

  it('rejects a BET with a reference', () => {
    const act = (): WagerTransaction =>
      WagerTransaction.create(props({ referenceExternalTransactionId: 'ext-ref' }));
    expect(act).toThrow(InvalidPayloadError);
  });

  it('rejects a reference to itself', () => {
    const act = (): WagerTransaction =>
      WagerTransaction.create(
        props({ kind: WagerTransactionKind.Win, referenceExternalTransactionId: 'ext-1' }),
      );
    expect(act).toThrow(InvalidPayloadError);
  });

  it('rejects a negative LOSS amount and accepts a zero one', () => {
    expect(() => withKind(WagerTransactionKind.Loss, { money: brl('-1.00') })).toThrow(
      InvalidAmountError,
    );
    expect(withKind(WagerTransactionKind.Loss, { money: brl('0.00') }).status).toBe(
      WagerTransactionStatus.Pending,
    );
  });

  it('rejects a non positive amount for the other kinds', () => {
    for (const kind of [
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ]) {
      expect(() => withKind(kind, { money: brl('0.00') })).toThrow(InvalidAmountError);
      expect(() => withKind(kind, { money: brl('-1.00') })).toThrow(InvalidAmountError);
    }
  });
});

describe('WagerTransaction.opening', () => {
  const opening = (money: Money): WagerTransaction =>
    WagerTransaction.opening({
      id: 'tx-open',
      walletId: 'wallet-1',
      playerId: 'player-1',
      money,
      payloadHash: 'hash-open',
      correlationId: 'corr-open',
      now: createdAt,
    });

  it('is born processed with the fixed fields', () => {
    const tx = opening(brl('100.00'));
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.kind).toBe(WagerTransactionKind.Opening);
    expect(tx.providerId).toBe('__system__');
    expect(tx.externalTransactionId).toBe('opening:wallet-1');
    expect(tx.idempotencyKey).toBe('opening:wallet-1');
    expect(tx.roundId).toBe('opening');
    expect(tx.gameId).toBe('opening');
    expect(tx.processedAt).toEqual(createdAt);
    expect(tx.balanceSnapshot?.equals(brl('100.00'))).toBe(true);
    expect(tx.isTerminal()).toBe(true);
  });

  it('rejects a non positive amount', () => {
    expect(() => opening(brl('0.00'))).toThrow(InvalidAmountError);
    expect(() => opening(brl('-1.00'))).toThrow(InvalidAmountError);
  });
});

describe('WagerTransaction.failNew', () => {
  it('is born failed with PROCESSING_FAILED', () => {
    const tx = WagerTransaction.failNew({ ...props(), balanceSnapshot: snapshot });
    expect(tx.status).toBe(WagerTransactionStatus.Failed);
    expect(tx.failureCode).toBe(FailureCode.ProcessingFailed);
    expect(tx.balanceSnapshot?.equals(snapshot)).toBe(true);
  });

  it('runs the same checks as create', () => {
    const act = (): WagerTransaction =>
      WagerTransaction.failNew({
        ...props({ kind: WagerTransactionKind.Refund }),
        balanceSnapshot: undefined,
      });
    expect(act).toThrow(ReferenceRequiredError);
  });
});

describe('WagerTransaction transitions', () => {
  const valid: Record<string, WagerTransactionStatus[]> = {
    markProcessed: [WagerTransactionStatus.Pending, WagerTransactionStatus.PendingReference],
    markPendingReference: [WagerTransactionStatus.Pending],
    reject: [WagerTransactionStatus.Pending, WagerTransactionStatus.PendingReference],
    fail: [WagerTransactionStatus.PendingReference],
  };

  const apply = (tx: WagerTransaction, method: string): void => {
    switch (method) {
      case 'markProcessed':
        tx.markProcessed({ referenceTransactionId: 'ref-1', balanceSnapshot: snapshot, at: later });
        return;
      case 'markPendingReference':
        tx.markPendingReference({ balanceSnapshot: snapshot, at: later });
        return;
      case 'reject':
        tx.reject({
          failureCode: FailureCode.InsufficientFunds,
          referenceTransactionId: 'ref-1',
          balanceSnapshot: snapshot,
          at: later,
        });
        return;
      default:
        tx.fail({ balanceSnapshot: snapshot, at: later });
    }
  };

  for (const method of Object.keys(valid)) {
    for (const status of allStatuses) {
      const allowed = valid[method]?.includes(status) === true;
      it(`${method} from ${status} ${allowed ? 'succeeds' : 'throws'}`, () => {
        const tx = inStatus(status);
        if (allowed) {
          apply(tx, method);
          expect(tx.updatedAt).toEqual(later);
        } else {
          expect(() => {
            apply(tx, method);
          }).toThrow(InvalidTransactionStateError);
        }
      });
    }
  }

  it('markProcessed records reference, snapshot and processedAt', () => {
    const tx = WagerTransaction.create(props());
    apply(tx, 'markProcessed');
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.referenceTransactionId).toBe('ref-1');
    expect(tx.balanceSnapshot?.equals(snapshot)).toBe(true);
    expect(tx.processedAt).toEqual(later);
    expect(tx.isTerminal()).toBe(true);
  });

  it('markPendingReference records the snapshot', () => {
    const tx = WagerTransaction.create(props());
    apply(tx, 'markPendingReference');
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.balanceSnapshot?.equals(snapshot)).toBe(true);
    expect(tx.isTerminal()).toBe(false);
  });

  it('reject records the failure code and reference', () => {
    const tx = WagerTransaction.create(props());
    apply(tx, 'reject');
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.referenceTransactionId).toBe('ref-1');
  });

  it('reject accepts every persisted rejection code and refuses the others', () => {
    for (const failureCode of PERSISTED_REJECTION_CODES) {
      const tx = WagerTransaction.create(props());
      tx.reject({
        failureCode,
        referenceTransactionId: undefined,
        balanceSnapshot: undefined,
        at: later,
      });
      expect(tx.failureCode).toBe(failureCode);
      expect(tx.referenceTransactionId).toBeUndefined();
    }
    const tx = WagerTransaction.create(props());
    expect(() => {
      tx.reject({
        failureCode: FailureCode.InternalError,
        referenceTransactionId: undefined,
        balanceSnapshot: undefined,
        at: later,
      });
    }).toThrow(InvalidTransactionStateError);
  });

  it('fail records PROCESSING_FAILED', () => {
    const tx = inStatus(WagerTransactionStatus.PendingReference);
    apply(tx, 'fail');
    expect(tx.status).toBe(WagerTransactionStatus.Failed);
    expect(tx.failureCode).toBe(FailureCode.ProcessingFailed);
  });

  it('InvalidTransactionStateError has no failure code', () => {
    const tx = inStatus(WagerTransactionStatus.Processed);
    try {
      apply(tx, 'fail');
    } catch (error) {
      expect(error).toHaveProperty('failureCode', undefined);
    }
  });
});

describe('WagerTransaction queries', () => {
  it('reports terminal statuses', () => {
    const expected: Record<WagerTransactionStatus, boolean> = {
      [WagerTransactionStatus.Pending]: false,
      [WagerTransactionStatus.PendingReference]: false,
      [WagerTransactionStatus.Processed]: true,
      [WagerTransactionStatus.Rejected]: true,
      [WagerTransactionStatus.Failed]: true,
    };
    for (const status of allStatuses) {
      expect(inStatus(status).isTerminal()).toBe(expected[status]);
    }
  });

  it('affectsBalance is false only for LOSS', () => {
    expect(withKind(WagerTransactionKind.Loss).affectsBalance()).toBe(false);
    for (const kind of [
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ]) {
      expect(withKind(kind).affectsBalance()).toBe(true);
    }
  });

  it('requiresReference and acceptsReference follow the kind', () => {
    expect(withKind(WagerTransactionKind.Refund).requiresReference()).toBe(true);
    expect(withKind(WagerTransactionKind.Rollback).requiresReference()).toBe(true);
    expect(withKind(WagerTransactionKind.Win).requiresReference()).toBe(false);
    expect(withKind(WagerTransactionKind.Bet).requiresReference()).toBe(false);
    expect(withKind(WagerTransactionKind.Bet).acceptsReference()).toBe(false);
    for (const kind of [
      WagerTransactionKind.Win,
      WagerTransactionKind.Loss,
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ]) {
      expect(withKind(kind).acceptsReference()).toBe(true);
    }
  });

  it('matchesPayload compares the hash exactly', () => {
    const tx = WagerTransaction.create(props());
    expect(tx.matchesPayload('hash-1')).toBe(true);
    expect(tx.matchesPayload('HASH-1')).toBe(false);
  });
});

describe('WagerTransaction.ledgerDirectionFor', () => {
  it('debits a BET', () => {
    expect(withKind(WagerTransactionKind.Bet).ledgerDirectionFor(undefined)).toBe(
      LedgerDirection.Debit,
    );
  });

  it('credits WIN and REFUND', () => {
    expect(withKind(WagerTransactionKind.Win).ledgerDirectionFor(undefined)).toBe(
      LedgerDirection.Credit,
    );
    expect(withKind(WagerTransactionKind.Refund).ledgerDirectionFor(undefined)).toBe(
      LedgerDirection.Credit,
    );
  });

  it('credits OPENING', () => {
    const tx = WagerTransaction.opening({
      id: 'tx-open',
      walletId: 'wallet-1',
      playerId: 'player-1',
      money: brl('1.00'),
      payloadHash: 'h',
      correlationId: 'c',
      now: createdAt,
    });
    expect(tx.ledgerDirectionFor(undefined)).toBe(LedgerDirection.Credit);
  });

  it('reverses the direction of the referenced transaction on ROLLBACK', () => {
    const rollback = withKind(WagerTransactionKind.Rollback);
    expect(rollback.ledgerDirectionFor(withKind(WagerTransactionKind.Bet))).toBe(
      LedgerDirection.Credit,
    );
    expect(rollback.ledgerDirectionFor(withKind(WagerTransactionKind.Win))).toBe(
      LedgerDirection.Debit,
    );
    expect(rollback.ledgerDirectionFor(withKind(WagerTransactionKind.Refund))).toBe(
      LedgerDirection.Debit,
    );
  });

  it('requires a valid reference on ROLLBACK', () => {
    const rollback = withKind(WagerTransactionKind.Rollback);
    expect(() => rollback.ledgerDirectionFor(undefined)).toThrow(InvalidLedgerPostingError);
    expect(() => rollback.ledgerDirectionFor(withKind(WagerTransactionKind.Loss))).toThrow(
      InvalidLedgerPostingError,
    );
  });

  it('throws for LOSS', () => {
    expect(() => withKind(WagerTransactionKind.Loss).ledgerDirectionFor(undefined)).toThrow(
      InvalidLedgerPostingError,
    );
  });
});

describe('WagerTransaction.rehydrate', () => {
  it('restores a terminal state without throwing', () => {
    for (const status of [
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
      WagerTransactionStatus.Failed,
    ]) {
      const state = { ...WagerTransaction.create(props()).toState(), status };
      expect(WagerTransaction.rehydrate(state).toState()).toEqual(state);
    }
  });

  it('restores a state that create would refuse', () => {
    const state = {
      ...WagerTransaction.create(props()).toState(),
      kind: WagerTransactionKind.Opening,
      providerId: '__system__',
      money: brl('0.00'),
    };
    expect(WagerTransaction.rehydrate(state).kind).toBe(WagerTransactionKind.Opening);
  });
});
