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

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: WagerTransactionKind;
  referenceExternalTransactionId: string;
  deadlineAt: string;
  walletVersion: number;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }

  static from(
    transaction: WagerTransaction,
    wallet: Wallet,
    deadlineAt: Date,
    ctx: EventContext,
  ): WagerTransactionPendingReference {
    const { referenceExternalTransactionId } = transaction;
    if (
      transaction.status !== WagerTransactionStatus.PendingReference ||
      referenceExternalTransactionId === undefined
    ) {
      throw new InvalidTransactionStateError(
        `cannot emit WagerTransactionPendingReference for a ${transaction.status} transaction`,
      );
    }
    const data: WagerTransactionPendingReferenceData = {
      transactionId: transaction.id,
      walletId: wallet.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      kind: transaction.kind,
      referenceExternalTransactionId,
      deadlineAt: deadlineAt.toISOString(),
      walletVersion: wallet.version,
    };
    return new WagerTransactionPendingReference(IntegrationEvent.propsFrom(ctx, wallet.id, data));
  }
}
