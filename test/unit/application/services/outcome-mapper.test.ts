import { describe, expect, it } from 'bun:test';
import { OutcomeMapper } from '@application/services/outcome-mapper';
import { FAILURE_CODE_METADATA, FailureAction, FailureCode } from '@domain/shared/failure-code';
import { Money } from '@domain/shared/money';
import { InvalidTransactionStateError } from '@domain/wagering/errors/invalid-transaction-state.error';
import { WagerTransaction } from '@domain/wagering/wager-transaction';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '@domain/wagering/wager-transaction-status';

const mapper = new OutcomeMapper();
const now = new Date('2026-01-01T00:00:00.000Z');

const pendingBet = (): WagerTransaction =>
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
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '10.00', currency: 'BRL' }),
    referenceExternalTransactionId: undefined,
    correlationId: 'corr-1',
    now,
  });

const balance = Money.from({ amount: '90.00', currency: 'BRL' });

describe('OutcomeMapper.toBody', () => {
  it('maps a processed transaction without failure fields', () => {
    const tx = pendingBet();
    tx.markProcessed({ referenceTransactionId: undefined, balanceSnapshot: balance, at: now });

    expect(mapper.toBody(tx, { replay: false })).toStrictEqual({
      transactionId: 'tx-1',
      status: 'PROCESSED',
      kind: WagerTransactionKind.Bet,
      balance: { amount: '90.00', currency: 'BRL' },
      idempotentReplay: false,
    });
  });

  it('maps a pending reference transaction without failure fields', () => {
    const tx = pendingBet();
    tx.markPendingReference({ balanceSnapshot: balance, at: now });

    const body = mapper.toBody(tx, { replay: false });

    expect(body.status).toBe('PENDING_REFERENCE');
    expect(body.balance).toStrictEqual({ amount: '90.00', currency: 'BRL' });
    expect('failureCode' in body).toBe(false);
    expect('retryable' in body).toBe(false);
    expect('action' in body).toBe(false);
  });

  it('maps a rejected transaction with failure metadata', () => {
    const tx = pendingBet();
    tx.reject({
      failureCode: FailureCode.InsufficientFunds,
      referenceTransactionId: undefined,
      balanceSnapshot: balance,
      at: now,
    });

    const metadata = FAILURE_CODE_METADATA[FailureCode.InsufficientFunds];
    expect(mapper.toBody(tx, { replay: false })).toStrictEqual({
      transactionId: 'tx-1',
      status: 'REJECTED',
      kind: WagerTransactionKind.Bet,
      failureCode: FailureCode.InsufficientFunds,
      retryable: metadata.retryable,
      action: metadata.action,
      balance: { amount: '90.00', currency: 'BRL' },
      idempotentReplay: false,
    });
  });

  it('maps a failed transaction with failure metadata and a null balance', () => {
    const tx = pendingBet();
    tx.markPendingReference({ balanceSnapshot: balance, at: now });
    tx.fail({ balanceSnapshot: undefined, at: now });

    const body = mapper.toBody(tx, { replay: false });

    expect(body.status).toBe('FAILED');
    expect(body.failureCode).toBe(FailureCode.ProcessingFailed);
    expect(body.retryable).toBe(false);
    expect(body.action).toBe(FailureAction.GiveUp);
    expect(body.balance).toBeNull();
  });

  it('flags the body as a replay when asked', () => {
    const tx = pendingBet();
    tx.markProcessed({ referenceTransactionId: undefined, balanceSnapshot: balance, at: now });

    expect(mapper.toBody(tx, { replay: true }).idempotentReplay).toBe(true);
  });

  it('refuses a transaction that is still pending', () => {
    expect(() => mapper.toBody(pendingBet(), { replay: false })).toThrow(
      InvalidTransactionStateError,
    );
  });

  it('refuses a rejected transaction without failure code', () => {
    const tx = WagerTransaction.rehydrate({
      ...pendingBet().toState(),
      status: WagerTransactionStatus.Rejected,
      failureCode: undefined,
    });

    expect(() => mapper.toBody(tx, { replay: false })).toThrow(InvalidTransactionStateError);
  });
});

describe('OutcomeMapper.walletNotFound', () => {
  it('builds the WALLET_NOT_FOUND body with null id and balance', () => {
    const metadata = FAILURE_CODE_METADATA[FailureCode.WalletNotFound];

    expect(mapper.walletNotFound({ kind: WagerTransactionKind.Win })).toStrictEqual({
      transactionId: null,
      status: 'REJECTED',
      kind: WagerTransactionKind.Win,
      failureCode: FailureCode.WalletNotFound,
      retryable: metadata.retryable,
      action: metadata.action,
      balance: null,
      idempotentReplay: false,
    });
  });
});
