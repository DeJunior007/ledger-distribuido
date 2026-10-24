import type { FailureAction, FailureCode } from '@domain/shared/failure-code';
import type { MoneyProps } from '@domain/shared/money';
import type { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';

export interface TransactionResultBody {
  transactionId: string | null;
  status: 'PROCESSED' | 'PENDING_REFERENCE' | 'REJECTED' | 'FAILED';
  kind: WagerTransactionKind;
  failureCode?: FailureCode;
  retryable?: boolean;
  action?: FailureAction;
  balance: MoneyProps | null;
  idempotentReplay: boolean;
}

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail: string;
  failureCode: FailureCode;
  retryable: boolean;
  action: FailureAction;
  transactionId?: string;
  walletId?: string;
  errors?: { path: string; message: string }[];
  idempotentReplay?: boolean;
}
