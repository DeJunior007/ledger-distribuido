import { Migration } from '@mikro-orm/migrations';

export class Migration0003LedgerEntries extends Migration {
  override up(): void {
    this.addSql(`CREATE TABLE ledger_entries (
  id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  account_kind text NOT NULL,
  wallet_id uuid,
  house_account_id uuid,
  direction text NOT NULL,
  amount numeric(20,2) NOT NULL,
  currency char(3) NOT NULL,
  balance_before numeric(20,2),
  balance_after numeric(20,2),
  wallet_version integer,
  created_at timestamptz NOT NULL,
  CONSTRAINT ledger_entries_pkey PRIMARY KEY (id),
  CONSTRAINT ledger_entries_transaction_fk FOREIGN KEY (transaction_id) REFERENCES wager_transactions (id),
  CONSTRAINT ledger_entries_wallet_fk FOREIGN KEY (wallet_id) REFERENCES wallets (id),
  CONSTRAINT ledger_entries_house_account_fk FOREIGN KEY (house_account_id) REFERENCES house_accounts (id),
  CONSTRAINT ledger_entries_account_kind_ck CHECK (account_kind IN ('WALLET', 'HOUSE')),
  CONSTRAINT ledger_entries_direction_ck CHECK (direction IN ('DEBIT', 'CREDIT')),
  CONSTRAINT ledger_entries_shape_ck CHECK (
    (account_kind = 'WALLET' AND wallet_id IS NOT NULL AND house_account_id IS NULL
      AND balance_before IS NOT NULL AND balance_after IS NOT NULL AND wallet_version IS NOT NULL)
    OR
    (account_kind = 'HOUSE' AND house_account_id IS NOT NULL AND wallet_id IS NULL
      AND balance_before IS NULL AND balance_after IS NULL AND wallet_version IS NULL)
  ),
  CONSTRAINT ledger_entries_amount_positive_ck CHECK (amount > 0),
  CONSTRAINT ledger_entries_balances_non_negative_ck CHECK (balance_before >= 0 AND balance_after >= 0),
  CONSTRAINT ledger_entries_arithmetic_ck CHECK (
    account_kind = 'HOUSE'
    OR (direction = 'CREDIT' AND balance_after = balance_before + amount)
    OR (direction = 'DEBIT' AND balance_after = balance_before - amount)
  ),
  CONSTRAINT ledger_entries_wallet_version_positive_ck CHECK (wallet_version >= 1),
  CONSTRAINT ledger_entries_currency_format_ck CHECK (currency ~ '^[A-Z]{3}$')
)`);
    this.addSql(`CREATE UNIQUE INDEX ledger_entries_one_per_wallet_uq
  ON ledger_entries (transaction_id, wallet_id) WHERE account_kind = 'WALLET'`);
    this.addSql(`CREATE UNIQUE INDEX ledger_entries_wallet_version_uq
  ON ledger_entries (wallet_id, wallet_version) WHERE account_kind = 'WALLET'`);
    this.addSql(`CREATE UNIQUE INDEX ledger_entries_one_house_per_tx_uq
  ON ledger_entries (transaction_id) WHERE account_kind = 'HOUSE'`);
    this.addSql(`CREATE INDEX ledger_entries_house_account_idx
  ON ledger_entries (house_account_id) WHERE account_kind = 'HOUSE'`);
    this.addSql(`CREATE VIEW wallet_ledger_entries AS
  SELECT id, wallet_id, transaction_id, direction, amount, currency,
         balance_before, balance_after, wallet_version, created_at
  FROM ledger_entries
  WHERE account_kind = 'WALLET'`);
  }

  override down(): void {
    this.addSql(`DROP VIEW wallet_ledger_entries`);
    this.addSql(`DROP INDEX ledger_entries_house_account_idx`);
    this.addSql(`DROP INDEX ledger_entries_one_house_per_tx_uq`);
    this.addSql(`DROP INDEX ledger_entries_wallet_version_uq`);
    this.addSql(`DROP INDEX ledger_entries_one_per_wallet_uq`);
    this.addSql(`DROP TABLE ledger_entries`);
  }
}
