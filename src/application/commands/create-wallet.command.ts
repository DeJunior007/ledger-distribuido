import type { MoneyProps } from '@domain/shared/money';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
  causationId: string;
}
