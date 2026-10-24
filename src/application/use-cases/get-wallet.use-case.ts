import { NotFoundError } from '@application/errors/not-found.error';
import type { Identity } from '@application/ports/provider-identity.port';
import { UnitOfWorkPort } from '@application/ports/unit-of-work.port';
import type { WalletBalanceView, WalletView } from '@application/views/wallet.view';

export interface GetWalletQuery {
  walletId: string;
  identity: Identity;
}

export class GetWalletUseCase {
  constructor(private readonly unitOfWork: UnitOfWorkPort) {}

  async execute(query: GetWalletQuery): Promise<WalletView | WalletBalanceView> {
    const wallet = await this.unitOfWork.read((repos) => repos.wallets.findById(query.walletId));
    if (wallet === undefined) {
      throw new NotFoundError('wallet not found');
    }
    if (query.identity.kind === 'provider') {
      return { id: wallet.id, balance: wallet.balance.toJSON(), version: wallet.version };
    }
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
    };
  }
}
