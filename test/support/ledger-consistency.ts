import { Client } from 'pg';
import { verifyLedgerChain } from '@domain/reconciliation/ledger-chain';
import type { ChainRow } from '@domain/reconciliation/ledger-chain';
import { Money } from '@domain/shared/money';
import { LedgerDirection } from '@domain/wallet/ledger-direction';
import { afterEachDatabaseCheck } from './current-database';
import type { DatabaseCheck } from './current-database';
import { waitFor } from './wait-for';

const IDLE_WAIT = { timeoutMs: 30_000, intervalMs: 50 } as const;

const BUSY_SQL = `SELECT
  EXISTS (
    SELECT 1
    FROM pending_reference_retries p
    JOIN wager_transactions t ON t.id = p.transaction_id
    WHERE t.status = 'PENDING_REFERENCE' AND p.resolved_at IS NULL AND p.locked_until > now()
  )
  OR EXISTS (
    SELECT 1 FROM outbox_messages WHERE published_at IS NULL AND locked_until > now()
  ) AS busy`;

const WALLETS_SQL = `SELECT id, currency, balance::text AS balance, version
FROM wallets
ORDER BY id`;

const WALLET_ENTRIES_SQL = `SELECT wallet_id AS "walletId", direction, amount::text AS amount, currency,
       balance_before::text AS "balanceBefore", balance_after::text AS "balanceAfter",
       wallet_version AS "walletVersion"
FROM wallet_ledger_entries
ORDER BY wallet_id, wallet_version`;

const UNBALANCED_TRANSACTIONS_SQL = `SELECT transaction_id AS "transactionId",
       count(*) FILTER (WHERE account_kind = 'WALLET')::int AS "walletLegs",
       count(*) FILTER (WHERE account_kind = 'HOUSE')::int AS "houseLegs",
       count(DISTINCT currency)::int AS currencies,
       sum(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END) = 0 AS "netZero"
FROM ledger_entries
GROUP BY transaction_id
HAVING count(*) FILTER (WHERE account_kind = 'WALLET') <> 1
    OR count(*) FILTER (WHERE account_kind = 'HOUSE') <> 1
    OR count(DISTINCT currency) <> 1
    OR sum(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END) <> 0
ORDER BY transaction_id`;

const HOUSE_BALANCES_SQL = `SELECT h.currency, h.purpose,
       coalesce(sum(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END), 0)::numeric(32,2)::text AS balance
FROM house_accounts h
LEFT JOIN ledger_entries e ON e.house_account_id = h.id AND e.account_kind = 'HOUSE'
GROUP BY h.id, h.currency, h.purpose
ORDER BY h.currency, h.purpose`;

interface WalletRow {
  readonly id: string;
  readonly currency: string;
  readonly balance: string;
  readonly version: number;
}

interface WalletEntryRow {
  readonly walletId: string;
  readonly direction: string;
  readonly amount: string;
  readonly currency: string;
  readonly balanceBefore: string;
  readonly balanceAfter: string;
  readonly walletVersion: number;
}

interface UnbalancedTransactionRow {
  readonly transactionId: string;
  readonly walletLegs: number;
  readonly houseLegs: number;
  readonly currencies: number;
  readonly netZero: boolean;
}

interface HouseBalanceRow {
  readonly currency: string;
  readonly purpose: string;
  readonly balance: string;
}

interface LedgerSnapshot {
  readonly wallets: readonly WalletRow[];
  readonly walletEntries: readonly WalletEntryRow[];
  readonly unbalancedTransactions: readonly UnbalancedTransactionRow[];
  readonly houseBalances: readonly HouseBalanceRow[];
}

export class LedgerConsistencyError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`ledger is inconsistent:\n${problems.join('\n')}`);
    this.name = 'LedgerConsistencyError';
  }
}

export class MissingSkipReasonError extends Error {
  constructor() {
    super('skipLedgerConsistency needs a reason');
    this.name = 'MissingSkipReasonError';
  }
}

export class UnknownLedgerDirectionError extends Error {
  constructor(direction: string) {
    super(`unknown ledger direction ${direction}`);
    this.name = 'UnknownLedgerDirectionError';
  }
}

let skipReason: string | undefined;

export const skipLedgerConsistency = (reason: string): void => {
  if (reason.trim() === '') {
    throw new MissingSkipReasonError();
  }
  skipReason = reason;
};

const DIRECTIONS = new Map<string, LedgerDirection>(
  Object.values(LedgerDirection).map((direction) => [direction, direction]),
);

const toDirection = (raw: string): LedgerDirection => {
  const direction = DIRECTIONS.get(raw);
  if (direction === undefined) {
    throw new UnknownLedgerDirectionError(raw);
  }
  return direction;
};

const waitUntilIdle = (client: Client): Promise<void> =>
  waitFor(async () => {
    const result = await client.query<{ busy: boolean }>(BUSY_SQL);
    return result.rows[0]?.busy === false;
  }, IDLE_WAIT);

const readSnapshot = async (client: Client): Promise<LedgerSnapshot> => {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const wallets = await client.query<WalletRow>(WALLETS_SQL);
    const walletEntries = await client.query<WalletEntryRow>(WALLET_ENTRIES_SQL);
    const unbalancedTransactions = await client.query<UnbalancedTransactionRow>(
      UNBALANCED_TRANSACTIONS_SQL,
    );
    const houseBalances = await client.query<HouseBalanceRow>(HOUSE_BALANCES_SQL);
    return {
      wallets: wallets.rows,
      walletEntries: walletEntries.rows,
      unbalancedTransactions: unbalancedTransactions.rows,
      houseBalances: houseBalances.rows,
    };
  } finally {
    await client.query('ROLLBACK');
  }
};

const groupEntries = (entries: readonly WalletEntryRow[]): Map<string, WalletEntryRow[]> => {
  const grouped = new Map<string, WalletEntryRow[]>();
  for (const entry of entries) {
    const list = grouped.get(entry.walletId) ?? [];
    list.push(entry);
    grouped.set(entry.walletId, list);
  }
  return grouped;
};

const toChainRow = (entry: WalletEntryRow): ChainRow => ({
  walletVersion: entry.walletVersion,
  direction: toDirection(entry.direction),
  amount: Money.fromSignedDecimal(entry.amount, entry.currency),
  balanceBefore: Money.fromSignedDecimal(entry.balanceBefore, entry.currency),
  balanceAfter: Money.fromSignedDecimal(entry.balanceAfter, entry.currency),
});

const ledgerSum = (rows: readonly ChainRow[], currency: string): Money =>
  rows.reduce(
    (sum, row) =>
      row.direction === LedgerDirection.Credit ? sum.add(row.amount) : sum.subtract(row.amount),
    Money.zero(currency),
  );

const walletProblems = (wallet: WalletRow, entries: readonly WalletEntryRow[]): string[] => {
  const storedBalance = Money.fromSignedDecimal(wallet.balance, wallet.currency);
  const problems: string[] = [];
  if (storedBalance.isNegative()) {
    problems.push(`wallet ${wallet.id}: negative balance`);
  }
  if (entries.some((entry) => entry.currency !== wallet.currency)) {
    problems.push(`wallet ${wallet.id}: ledger entry in another currency`);
    return problems;
  }
  const rows = entries.map(toChainRow);
  if (!ledgerSum(rows, wallet.currency).equals(storedBalance)) {
    problems.push(`wallet ${wallet.id}: balance differs from the sum of its ledger entries`);
  }
  const chain = verifyLedgerChain({ rows, walletVersion: wallet.version, storedBalance });
  if (!chain.valid) {
    problems.push(
      `wallet ${wallet.id}: invalid chain from version ${String(chain.firstDivergentVersion)} (${chain.problems.join(', ')})`,
    );
  }
  return problems;
};

const transactionProblems = (rows: readonly UnbalancedTransactionRow[]): string[] =>
  rows.map(
    (row) =>
      `transaction ${row.transactionId}: ${String(row.walletLegs)} wallet legs, ${String(row.houseLegs)} house legs, ${String(row.currencies)} currencies, net zero ${String(row.netZero)}`,
  );

const currencyProblems = (snapshot: LedgerSnapshot): string[] => {
  const totals = new Map<string, Money>();
  const accumulate = (amount: Money): void => {
    const current = totals.get(amount.currency) ?? Money.zero(amount.currency);
    totals.set(amount.currency, current.add(amount));
  };
  for (const wallet of snapshot.wallets) {
    accumulate(Money.fromSignedDecimal(wallet.balance, wallet.currency));
  }
  for (const house of snapshot.houseBalances) {
    accumulate(Money.fromSignedDecimal(house.balance, house.currency));
  }
  return [...totals.entries()]
    .filter(([, total]) => !total.isZero())
    .map(([currency]) => `currency ${currency}: wallets and house accounts do not sum to zero`);
};

const snapshotProblems = (snapshot: LedgerSnapshot): string[] => {
  const entriesByWallet = groupEntries(snapshot.walletEntries);
  return [
    ...snapshot.wallets.flatMap((wallet) =>
      walletProblems(wallet, entriesByWallet.get(wallet.id) ?? []),
    ),
    ...transactionProblems(snapshot.unbalancedTransactions),
    ...currencyProblems(snapshot),
  ];
};

export const assertLedgerConsistency = async (databaseUrl: string): Promise<void> => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await waitUntilIdle(client);
    const problems = snapshotProblems(await readSnapshot(client));
    if (problems.length > 0) {
      throw new LedgerConsistencyError(problems);
    }
  } finally {
    await client.end();
  }
};

const checkUnlessSkipped: DatabaseCheck = async (databaseUrl) => {
  if (skipReason === undefined) {
    await assertLedgerConsistency(databaseUrl);
  }
};

export const ledgerConsistencyAfterEach = (fallbackUrl?: string): (() => Promise<void>) => {
  const check = afterEachDatabaseCheck(checkUnlessSkipped, fallbackUrl);
  return async () => {
    try {
      await check();
    } finally {
      skipReason = undefined;
    }
  };
};
