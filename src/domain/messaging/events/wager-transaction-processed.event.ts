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

export interface WagerTransactionProcessedData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceTransactionId?: string;
  balance: MoneyProps;
  walletVersion: number;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  static from(
    transaction: WagerTransaction,
    wallet: Wallet,
    ctx: EventContext,
  ): WagerTransactionProcessed {
    const { processedAt, referenceTransactionId } = transaction;
    if (transaction.status !== WagerTransactionStatus.Processed || processedAt === undefined) {
      throw new InvalidTransactionStateError(
        `cannot emit WagerTransactionProcessed for a ${transaction.status} transaction`,
      );
    }
    const data: WagerTransactionProcessedData = {
      transactionId: transaction.id,
      walletId: wallet.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      money: transaction.money.toJSON(),
      ...(referenceTransactionId === undefined ? {} : { referenceTransactionId }),
      balance: wallet.balance.toJSON(),
      walletVersion: wallet.version,
      processedAt: processedAt.toISOString(),
    };
    return new WagerTransactionProcessed(IntegrationEvent.propsFrom(ctx, wallet.id, data));
  }
}
