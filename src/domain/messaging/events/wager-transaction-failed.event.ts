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

export interface WagerTransactionFailedData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: WagerTransactionKind;
  failureCode: 'PROCESSING_FAILED';
  walletVersion: number;
}

export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionFailedData> {
  readonly eventType = 'WagerTransactionFailed';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionFailedData>) {
    super(props);
  }

  static from(
    transaction: WagerTransaction,
    wallet: Wallet,
    ctx: EventContext,
  ): WagerTransactionFailed {
    if (transaction.status !== WagerTransactionStatus.Failed) {
      throw new InvalidTransactionStateError(
        `cannot emit WagerTransactionFailed for a ${transaction.status} transaction`,
      );
    }
    const data: WagerTransactionFailedData = {
      transactionId: transaction.id,
      walletId: wallet.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      kind: transaction.kind,
      failureCode: 'PROCESSING_FAILED',
      walletVersion: wallet.version,
    };
    return new WagerTransactionFailed(IntegrationEvent.propsFrom(ctx, wallet.id, data));
  }
}
