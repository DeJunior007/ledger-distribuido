import { NotFoundError } from '@application/errors/not-found.error';
import type { Identity } from '@application/ports/provider-identity.port';
import { UnitOfWorkPort } from '@application/ports/unit-of-work.port';
import type { WagerTransactionView } from '@application/views/wager-transaction.view';
import type { WagerTransaction } from '@domain/wagering/wager-transaction';

export interface GetWagerTransactionQuery {
  transactionId: string;
  identity: Identity;
}

export function isVisibleTo(identity: Identity, providerId: string): boolean {
  return identity.kind !== 'provider' || identity.providerId === providerId;
}

export function toWagerTransactionView(transaction: WagerTransaction): WagerTransactionView {
  const view: WagerTransactionView = {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    createdAt: transaction.createdAt.toISOString(),
  };
  if (transaction.referenceExternalTransactionId !== undefined) {
    view.referenceExternalTransactionId = transaction.referenceExternalTransactionId;
  }
  if (transaction.referenceTransactionId !== undefined) {
    view.referenceTransactionId = transaction.referenceTransactionId;
  }
  if (transaction.failureCode !== undefined) {
    view.failureCode = transaction.failureCode;
  }
  if (transaction.balanceSnapshot !== undefined) {
    view.balance = transaction.balanceSnapshot.toJSON();
  }
  if (transaction.processedAt !== undefined) {
    view.processedAt = transaction.processedAt.toISOString();
  }
  return view;
}

export class GetWagerTransactionUseCase {
  constructor(private readonly unitOfWork: UnitOfWorkPort) {}

  async execute(query: GetWagerTransactionQuery): Promise<WagerTransactionView> {
    const transaction = await this.unitOfWork.read((repos) =>
      repos.transactions.findById(query.transactionId),
    );
    if (transaction === undefined || !isVisibleTo(query.identity, transaction.providerId)) {
      throw new NotFoundError('transaction not found');
    }
    return toWagerTransactionView(transaction);
  }
}
