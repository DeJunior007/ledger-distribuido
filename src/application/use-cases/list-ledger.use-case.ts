import { NotFoundError } from '@application/errors/not-found.error';
import { UnitOfWorkPort } from '@application/ports/unit-of-work.port';
import type { WalletLedgerEntryView } from '@application/views/wallet-ledger-entry.view';

export interface ListLedgerQuery {
  walletId: string;
  beforeVersion: number | undefined;
  limit: number;
}

export interface LedgerPage {
  entries: WalletLedgerEntryView[];
  nextBeforeVersion: number | undefined;
}

export class ListLedgerUseCase {
  constructor(private readonly unitOfWork: UnitOfWorkPort) {}

  async execute(query: ListLedgerQuery): Promise<LedgerPage> {
    const rows = await this.unitOfWork.read(async (repos) => {
      const wallet = await repos.wallets.findById(query.walletId);
      if (wallet === undefined) {
        throw new NotFoundError('wallet not found');
      }
      return repos.ledger.listWalletEntries(query.walletId, {
        beforeVersion: query.beforeVersion,
        limit: query.limit + 1,
      });
    });
    const hasNext = rows.length > query.limit;
    const entries = rows.slice(0, query.limit).map((entry): WalletLedgerEntryView => ({
      id: entry.id,
      transactionId: entry.transactionId,
      direction: entry.direction,
      money: entry.money.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(),
      walletVersion: entry.walletVersion,
      createdAt: entry.createdAt.toISOString(),
    }));
    const last = entries.at(-1);
    return {
      entries,
      nextBeforeVersion: hasNext && last !== undefined ? last.walletVersion : undefined,
    };
  }
}
