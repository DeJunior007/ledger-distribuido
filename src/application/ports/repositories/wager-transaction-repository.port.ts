import type { WagerTransaction } from '@domain/wagering/wager-transaction';

export abstract class WagerTransactionRepositoryPort {
  abstract findById(
    id: string,
    options?: { refresh?: boolean },
  ): Promise<WagerTransaction | undefined>;
  abstract findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
    options?: { refresh?: boolean },
  ): Promise<WagerTransaction | undefined>;
  abstract isReversed(transactionId: string): Promise<boolean>;
  abstract hasProcessedWinInRound(walletId: string, roundId: string): Promise<boolean>;
  abstract insert(transaction: WagerTransaction): void;
  abstract update(transaction: WagerTransaction): void;
}
