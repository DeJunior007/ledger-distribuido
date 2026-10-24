import { describe, expect, it } from 'bun:test';
import { AnomalyDetector } from '@application/services/anomaly-detector';
import { FailureCode } from '@domain/shared/failure-code';
import { Money } from '@domain/shared/money';
import { WagerTransaction } from '@domain/wagering/wager-transaction';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';

const detector = new AnomalyDetector();
const now = new Date('2026-01-01T00:00:00.000Z');
const balance = Money.from({ amount: '50.00', currency: 'BRL' });

const created = (
  kind: WagerTransactionKind,
  id: string,
  reference: string | undefined,
): WagerTransaction =>
  WagerTransaction.create({
    id,
    providerId: 'provider-1',
    externalTransactionId: `ext-${id}`,
    idempotencyKey: `key-${id}`,
    payloadHash: `hash-${id}`,
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: Money.from({ amount: '10.00', currency: 'BRL' }),
    referenceExternalTransactionId: reference,
    correlationId: 'corr-1',
    now,
  });

const processed = (
  kind: WagerTransactionKind,
  id: string,
  reference: string | undefined,
): WagerTransaction => {
  const tx = created(kind, id, reference);
  tx.markProcessed({ referenceTransactionId: undefined, balanceSnapshot: balance, at: now });
  return tx;
};

const bet = (): WagerTransaction => processed(WagerTransactionKind.Bet, 'bet', undefined);

describe('AnomalyDetector.isReversalAfterWin', () => {
  it.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])(
    'flags a processed %s of a BET when the round has a processed WIN',
    (kind) => {
      expect(
        detector.isReversalAfterWin({
          transaction: processed(kind, 'reversal', 'ext-bet'),
          reference: bet(),
          hasProcessedWinInRound: true,
        }),
      ).toBe(true);
    },
  );

  it('ignores a reversal when the round has no processed WIN', () => {
    expect(
      detector.isReversalAfterWin({
        transaction: processed(WagerTransactionKind.Refund, 'reversal', 'ext-bet'),
        reference: bet(),
        hasProcessedWinInRound: false,
      }),
    ).toBe(false);
  });

  it('ignores a reversal that was not processed', () => {
    const refund = created(WagerTransactionKind.Refund, 'reversal', 'ext-bet');
    refund.reject({
      failureCode: FailureCode.ReferenceAlreadyReversed,
      referenceTransactionId: undefined,
      balanceSnapshot: balance,
      at: now,
    });

    expect(
      detector.isReversalAfterWin({
        transaction: refund,
        reference: bet(),
        hasProcessedWinInRound: true,
      }),
    ).toBe(false);
  });

  it('ignores a rollback whose reference is not a BET', () => {
    expect(
      detector.isReversalAfterWin({
        transaction: processed(WagerTransactionKind.Rollback, 'reversal', 'ext-win'),
        reference: processed(WagerTransactionKind.Win, 'win', 'ext-bet'),
        hasProcessedWinInRound: true,
      }),
    ).toBe(false);
  });

  it('ignores a reversal without reference', () => {
    expect(
      detector.isReversalAfterWin({
        transaction: processed(WagerTransactionKind.Refund, 'reversal', 'ext-bet'),
        reference: undefined,
        hasProcessedWinInRound: true,
      }),
    ).toBe(false);
  });

  it.each([WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Loss])(
    'ignores a processed %s',
    (kind) => {
      const reference = kind === WagerTransactionKind.Bet ? undefined : 'ext-bet';
      expect(
        detector.isReversalAfterWin({
          transaction: processed(kind, 'other', reference),
          reference: bet(),
          hasProcessedWinInRound: true,
        }),
      ).toBe(false);
    },
  );
});
