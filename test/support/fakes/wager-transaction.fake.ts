import { WagerTransactionRepositoryPort } from '@application/ports/repositories/wager-transaction-repository.port';
import { WagerTransaction, type WagerTransactionState } from '@domain/wagering/wager-transaction';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '@domain/wagering/wager-transaction-status';
import { settle } from './in-memory-unit-of-work.fake';
import type { FakeTransaction } from './in-memory-unit-of-work.fake';

const REVERSAL_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

export class InMemoryWagerTransactionRepository extends WagerTransactionRepositoryPort {
  constructor(private readonly transaction: FakeTransaction) {
    super();
  }

  findById(id: string): Promise<WagerTransaction | undefined> {
    return settle(() => {
      const row = this.transaction.transactions.find(id);
      return row === undefined ? undefined : WagerTransaction.rehydrate(row);
    });
  }

  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    return settle(() => {
      const row = this.rows().find(
        (candidate) =>
          candidate.providerId === providerId &&
          candidate.externalTransactionId === externalTransactionId,
      );
      return row === undefined ? undefined : WagerTransaction.rehydrate(row);
    });
  }

  isReversed(transactionId: string): Promise<boolean> {
    return settle(() =>
      this.rows().some(
        (candidate) =>
          candidate.referenceTransactionId === transactionId &&
          REVERSAL_KINDS.includes(candidate.kind) &&
          candidate.status === WagerTransactionStatus.Processed,
      ),
    );
  }

  hasProcessedWinInRound(walletId: string, roundId: string): Promise<boolean> {
    return settle(() =>
      this.rows().some(
        (candidate) =>
          candidate.walletId === walletId &&
          candidate.roundId === roundId &&
          candidate.kind === WagerTransactionKind.Win &&
          candidate.status === WagerTransactionStatus.Processed,
      ),
    );
  }

  insert(transaction: WagerTransaction): void {
    this.transaction.transactions.insert(transaction.toState());
  }

  update(transaction: WagerTransaction): void {
    this.transaction.transactions.update(transaction.toState());
  }

  private rows(): WagerTransactionState[] {
    return this.transaction.transactions.rows();
  }
}
