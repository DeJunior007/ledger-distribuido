import type { EntityManager } from '@mikro-orm/postgresql';
import { z } from 'zod';
import type {
  CurrencySums,
  ReconciliationRepositoryPort,
  ReconciliationRunInput,
  WalletBatchRow,
  WalletSnapshot,
} from '@application/ports/repositories/reconciliation-repository.port';
import type { Money } from '@domain/shared/money';
import { corruptedRow } from '../mappers/persisted-values.mapper';
import { ReconciliationRunRecord } from '../records/reconciliation-runs.record';
import {
  currencySumsRowSchema,
  snapshotChainRowSchema,
  snapshotTotalsRowSchema,
  snapshotWalletRowSchema,
  walletBatchRowSchema,
} from '../rows/reconciliation.row';

const SNAPSHOT_WALLET_SQL = `SELECT id, currency, balance, version FROM wallets WHERE id = ?`;

const SNAPSHOT_TOTALS_SQL = `SELECT
  COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0)::numeric(32,2) AS credits,
  COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0)::numeric(32,2) AS debits,
  count(*)::int AS entries
FROM wallet_ledger_entries
WHERE wallet_id = ?`;

const SNAPSHOT_CHAIN_SQL = `SELECT wallet_version, direction, amount, currency, balance_before, balance_after
FROM wallet_ledger_entries
WHERE wallet_id = ?
ORDER BY wallet_version`;

const GLOBAL_SUMS_SQL = `WITH currencies AS (
  SELECT currency FROM wallets
  UNION
  SELECT currency FROM house_accounts
)
SELECT
  c.currency,
  COALESCE((SELECT SUM(w.balance) FROM wallets w WHERE w.currency = c.currency), 0)::numeric(32,2) AS wallets_total,
  COALESCE((SELECT SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END)
            FROM ledger_entries e JOIN house_accounts h ON h.id = e.house_account_id
            WHERE h.currency = c.currency AND h.purpose = 'FUNDING'), 0)::numeric(32,2) AS funding_balance,
  COALESCE((SELECT SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END)
            FROM ledger_entries e JOIN house_accounts h ON h.id = e.house_account_id
            WHERE h.currency = c.currency AND h.purpose = 'GAMING'), 0)::numeric(32,2) AS gaming_balance,
  COALESCE((SELECT SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END)
            FROM ledger_entries e WHERE e.currency = c.currency), 0)::numeric(32,2) AS ledger_net
FROM currencies c`;

const WALLET_BATCH_SQL = `SELECT
  w.id, w.balance, w.version,
  COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END), 0)::numeric(32,2) AS calculated,
  count(e.id)::int AS entries,
  min(e.wallet_version) AS first_version,
  max(e.wallet_version) AS last_version
FROM wallets w
LEFT JOIN wallet_ledger_entries e ON e.wallet_id = w.id
WHERE (?::uuid IS NULL OR w.id > ?::uuid)
GROUP BY w.id
ORDER BY w.id
LIMIT ?`;

const parseRows = <Schema extends z.ZodTypeAny>(
  schema: Schema,
  raw: unknown,
): z.output<Schema>[] => {
  const parsed = z.array(schema).safeParse(raw);
  if (!parsed.success) {
    throw corruptedRow();
  }
  return parsed.data;
};

const amountOf = (money: Money | undefined): string | null =>
  money === undefined ? null : money.toJSON().amount;

export class MikroOrmReconciliationRepository implements ReconciliationRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async walletSnapshot(walletId: string): Promise<WalletSnapshot | undefined> {
    const [wallet] = parseRows(
      snapshotWalletRowSchema,
      await this.em.execute(SNAPSHOT_WALLET_SQL, [walletId]),
    );
    if (wallet === undefined) {
      return undefined;
    }
    const [totals] = parseRows(
      snapshotTotalsRowSchema,
      await this.em.execute(SNAPSHOT_TOTALS_SQL, [walletId]),
    );
    if (totals === undefined) {
      throw corruptedRow();
    }
    const chain = parseRows(
      snapshotChainRowSchema,
      await this.em.execute(SNAPSHOT_CHAIN_SQL, [walletId]),
    );
    return { ...wallet, ...totals, chain };
  }

  async globalSums(): Promise<CurrencySums[]> {
    return parseRows(currencySumsRowSchema, await this.em.execute(GLOBAL_SUMS_SQL, []));
  }

  async walletBatch(afterId: string | undefined, limit: number): Promise<WalletBatchRow[]> {
    const after = afterId ?? null;
    return parseRows(
      walletBatchRowSchema,
      await this.em.execute(WALLET_BATCH_SQL, [after, after, limit]),
    );
  }

  insertRun(run: ReconciliationRunInput): void {
    this.em.persist(
      new ReconciliationRunRecord({
        id: run.id,
        scope: run.scope,
        walletId: run.walletId ?? null,
        consistent: run.consistent,
        checkedEntries: run.checkedEntries,
        storedAmount: amountOf(run.stored),
        calculatedAmount: amountOf(run.calculated),
        differenceAmount: amountOf(run.difference),
        currency: run.currency ?? null,
        firstDivergentVersion: run.firstDivergentVersion ?? null,
        details: { ...run.details },
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      }),
    );
  }
}
