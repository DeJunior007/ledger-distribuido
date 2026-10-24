import type { MoneyProps } from '../../shared/money';
import type { LedgerDirection } from '../../wallet/ledger-direction';
import type { Wallet } from '../../wallet/wallet';
import type { WalletLedgerEntry } from '../../wallet/wallet-ledger-entry';
import {
  IntegrationEvent,
  type EventContext,
  type IntegrationEventProps,
} from '../integration-event';

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    const data: WalletBalanceChangedData = {
      walletId: wallet.id,
      transactionId: entry.transactionId,
      direction: entry.direction,
      money: entry.money.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(),
      walletVersion: wallet.version,
    };
    return new WalletBalanceChanged(IntegrationEvent.propsFrom(ctx, wallet.id, data));
  }
}
