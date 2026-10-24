import type { FailureCode } from '@domain/shared/failure-code';
import type { MoneyProps } from '@domain/shared/money';
import type { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import type { WagerTransactionStatus } from '@domain/wagering/wager-transaction-status';

export interface WagerTransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  balance?: MoneyProps;
  createdAt: string;
  processedAt?: string;
}
