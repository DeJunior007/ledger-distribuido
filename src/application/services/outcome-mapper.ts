import type { TransactionResultBody } from '@domain/idempotency/response-bodies';
import { FAILURE_CODE_METADATA, FailureCode } from '@domain/shared/failure-code';
import { InvalidTransactionStateError } from '@domain/wagering/errors/invalid-transaction-state.error';
import type { WagerTransaction } from '@domain/wagering/wager-transaction';
import { WagerTransactionStatus } from '@domain/wagering/wager-transaction-status';
import type { SubmitWagerTransactionCommand } from '@application/commands/submit-wager-transaction.command';

type OutcomeStatus = TransactionResultBody['status'];

function outcomeStatusOf(status: WagerTransactionStatus): OutcomeStatus {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return 'PROCESSED';
    case WagerTransactionStatus.PendingReference:
      return 'PENDING_REFERENCE';
    case WagerTransactionStatus.Rejected:
      return 'REJECTED';
    case WagerTransactionStatus.Failed:
      return 'FAILED';
    case WagerTransactionStatus.Pending:
      throw new InvalidTransactionStateError('PENDING transaction has no outcome body');
  }
}

function failureFields(
  failureCode: FailureCode,
): Pick<TransactionResultBody, 'failureCode' | 'retryable' | 'action'> {
  const metadata = FAILURE_CODE_METADATA[failureCode];
  return { failureCode, retryable: metadata.retryable, action: metadata.action };
}

function failureFieldsOf(
  tx: WagerTransaction,
  status: OutcomeStatus,
): Pick<TransactionResultBody, 'failureCode' | 'retryable' | 'action'> {
  if (status !== 'REJECTED' && status !== 'FAILED') {
    return {};
  }
  if (tx.failureCode === undefined) {
    throw new InvalidTransactionStateError(`${status} transaction has no failure code`);
  }
  return failureFields(tx.failureCode);
}

export class OutcomeMapper {
  toBody(tx: WagerTransaction, options: { replay: boolean }): TransactionResultBody {
    const status = outcomeStatusOf(tx.status);
    return {
      transactionId: tx.id,
      status,
      kind: tx.kind,
      ...failureFieldsOf(tx, status),
      balance: tx.balanceSnapshot === undefined ? null : tx.balanceSnapshot.toJSON(),
      idempotentReplay: options.replay,
    };
  }

  walletNotFound(command: Pick<SubmitWagerTransactionCommand, 'kind'>): TransactionResultBody {
    return {
      transactionId: null,
      status: 'REJECTED',
      kind: command.kind,
      ...failureFields(FailureCode.WalletNotFound),
      balance: null,
      idempotentReplay: false,
    };
  }
}
