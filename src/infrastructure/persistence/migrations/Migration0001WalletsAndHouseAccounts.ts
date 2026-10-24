import { Migration } from '@mikro-orm/migrations';

export class Migration0001WalletsAndHouseAccounts extends Migration {
  override up(): void {
    this.addSql(`CREATE TABLE wallets (
  id uuid NOT NULL,
  player_id uuid NOT NULL,
  currency char(3) NOT NULL,
  balance numeric(20,2) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT wallets_pkey PRIMARY KEY (id),
  CONSTRAINT wallets_player_currency_uq UNIQUE (player_id, currency),
  CONSTRAINT wallets_balance_non_negative_ck CHECK (balance >= 0),
  CONSTRAINT wallets_version_positive_ck CHECK (version >= 1),
  CONSTRAINT wallets_currency_format_ck CHECK (currency ~ '^[A-Z]{3}$')
)`);
    this.addSql(`CREATE TABLE house_accounts (
  id uuid NOT NULL,
  currency char(3) NOT NULL,
  purpose text NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT house_accounts_pkey PRIMARY KEY (id),
  CONSTRAINT house_accounts_currency_purpose_uq UNIQUE (currency, purpose),
  CONSTRAINT house_accounts_purpose_ck CHECK (purpose IN ('GAMING', 'FUNDING')),
  CONSTRAINT house_accounts_currency_format_ck CHECK (currency ~ '^[A-Z]{3}$')
)`);
  }

  override down(): void {
    this.addSql(`DROP TABLE house_accounts`);
    this.addSql(`DROP TABLE wallets`);
  }
}
