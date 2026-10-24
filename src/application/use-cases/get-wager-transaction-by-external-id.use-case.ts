import { NotFoundError } from '@application/errors/not-found.error';
import type { Identity } from '@application/ports/provider-identity.port';
import { UnitOfWorkPort } from '@application/ports/unit-of-work.port';
import type { WagerTransactionView } from '@application/views/wager-transaction.view';
import { isVisibleTo, toWagerTransactionView } from './get-wager-transaction.use-case';

export interface GetWagerTransactionByExternalIdQuery {
  providerId: string;
  externalTransactionId: string;
  identity: Identity;
}

export class GetWagerTransactionByExternalIdUseCase {
  constructor(private readonly unitOfWork: UnitOfWorkPort) {}

  async execute(query: GetWagerTransactionByExternalIdQuery): Promise<WagerTransactionView> {
    if (!isVisibleTo(query.identity, query.providerId)) {
      throw new NotFoundError('transaction not found');
    }
    const transaction = await this.unitOfWork.read((repos) =>
      repos.transactions.findByProviderAndExternalId(query.providerId, query.externalTransactionId),
    );
    if (transaction === undefined) {
      throw new NotFoundError('transaction not found');
    }
    return toWagerTransactionView(transaction);
  }
}
