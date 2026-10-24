import {
  FAILURE_CODE_METADATA,
  type FailureAction,
  type FailureCode,
} from '../../shared/failure-code';
import type { MoneyProps } from '../../shared/money';
import { InvalidTransactionStateError } from '../../wagering/errors/invalid-transaction-state.error';
import type { WagerTransaction } from '../../wagering/wager-transaction';
import type { WagerTransactionKind } from '../../wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '../../wagering/wager-transaction-status';
import type { Wallet } from '../../wallet/wallet';
import {
  IntegrationEvent,
  type EventContext,
  type IntegrationEventProps,
} from '../integration-event';

export interface WagerTransactionRejectedData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  failureCode: FailureCode;
  retryable: boolean;
  action: FailureAction;
  referenceTransactionId?: string;
  balance: MoneyProps;
  walletVersion: number;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  static from(
    transaction: WagerTransaction,
    wallet: Wallet,
    ctx: EventContext,
  ): WagerTransactionRejected {
    const { failureCode, referenceTransactionId } = transaction;
    if (transaction.status !== WagerTransactionStatus.Rejected || failureCode === undefined) {
      throw new InvalidTransactionStateError(
        `cannot emit WagerTransactionRejected for a ${transaction.status} transaction`,
      );
    }
    const metadata = FAILURE_CODE_METADATA[failureCode];
    const data: WagerTransactionRejectedData = {
      transactionId: transaction.id,
      walletId: wallet.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      kind: transaction.kind,
      money: transaction.money.toJSON(),
      failureCode,
      retryable: metadata.retryable,
      action: metadata.action,
      ...(referenceTransactionId === undefined ? {} : { referenceTransactionId }),
      balance: wallet.balance.toJSON(),
      walletVersion: wallet.version,
    };
    return new WagerTransactionRejected(IntegrationEvent.propsFrom(ctx, wallet.id, data));
  }
}
