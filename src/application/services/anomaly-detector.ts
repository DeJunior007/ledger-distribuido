import type { WagerTransaction } from '@domain/wagering/wager-transaction';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '@domain/wagering/wager-transaction-status';

export interface ReversalAfterWinInput {
  transaction: WagerTransaction;
  reference: WagerTransaction | undefined;
  hasProcessedWinInRound: boolean;
}

export class AnomalyDetector {
  isReversalAfterWin(input: ReversalAfterWinInput): boolean {
    const { transaction, reference, hasProcessedWinInRound } = input;
    const isReversal =
      transaction.kind === WagerTransactionKind.Refund ||
      transaction.kind === WagerTransactionKind.Rollback;
    return (
      isReversal &&
      transaction.status === WagerTransactionStatus.Processed &&
      reference?.kind === WagerTransactionKind.Bet &&
      hasProcessedWinInRound
    );
  }
}
