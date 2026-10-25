import type { EntityManager } from '@mikro-orm/postgresql';
import type { LedgerRepositoryPort } from '@application/ports/repositories/ledger-repository.port';
import { Money } from '@domain/shared/money';
import type { LedgerPosting } from '@domain/wallet/ledger-posting';
import { WalletLedgerEntry } from '@domain/wallet/wallet-ledger-entry';
import * as ledgerEntryMapper from '../mappers/ledger-entry.mapper';
import { corruptedRow } from '../mappers/persisted-values.mapper';
import { walletLedgerEntryRowsSchema } from '../rows/wallet-ledger-entries.row';
import type { WalletLedgerEntryRow } from '../rows/wallet-ledger-entries.row';

const LIST_WALLET_ENTRIES_SQL = `SELECT id, wallet_id, transaction_id, direction, amount, currency,
       balance_before, balance_after, wallet_version, created_at
FROM wallet_ledger_entries
WHERE wallet_id = ? AND (?::integer IS NULL OR wallet_version < ?)
ORDER BY wallet_version DESC
LIMIT ?`;

const toWalletEntry = (row: WalletLedgerEntryRow): WalletLedgerEntry =>
  WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.walletId,
    transactionId: row.transactionId,
    direction: row.direction,
    money: Money.fromPersistence(row.amount, row.currency),
    balanceBefore: Money.fromPersistence(row.balanceBefore, row.currency),
    balanceAfter: Money.fromPersistence(row.balanceAfter, row.currency),
    walletVersion: row.walletVersion,
    createdAt: row.createdAt,
  });

export class MikroOrmLedgerRepository implements LedgerRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  insertPosting(posting: LedgerPosting): void {
    this.em.persist(ledgerEntryMapper.toRecord(posting.walletEntry));
    this.em.persist(ledgerEntryMapper.toRecord(posting.houseEntry));
  }

  async listWalletEntries(
    walletId: string,
    page: { beforeVersion: number | undefined; limit: number },
  ): Promise<WalletLedgerEntry[]> {
    const beforeVersion = page.beforeVersion ?? null;
    const parsed = walletLedgerEntryRowsSchema.safeParse(
      await this.em.execute(LIST_WALLET_ENTRIES_SQL, [
        walletId,
        beforeVersion,
        beforeVersion,
        page.limit,
      ]),
    );
    if (!parsed.success) {
      throw corruptedRow();
    }
    return parsed.data.map(toWalletEntry);
  }
}
