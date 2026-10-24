import { Migration } from '@mikro-orm/migrations';

export class Migration0002WagerTransactions extends Migration {
  override up(): void {
    this.addSql(`CREATE TABLE wager_transactions (
  id uuid NOT NULL,
  provider_id text NOT NULL,
  external_transaction_id text NOT NULL,
  idempotency_key text NOT NULL,
  payload_hash char(64) NOT NULL,
  wallet_id uuid NOT NULL,
  player_id uuid NOT NULL,
  round_id text NOT NULL,
  game_id text NOT NULL,
  kind text NOT NULL,
  amount numeric(20,2) NOT NULL,
  currency char(3) NOT NULL,
  reference_external_transaction_id text,
  reference_transaction_id uuid,
  status text NOT NULL,
  failure_code text,
  balance_snapshot_amount numeric(20,2),
  balance_snapshot_currency char(3),
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL,
  processed_at timestamptz,
  updated_at timestamptz NOT NULL,
  CONSTRAINT wager_transactions_pkey PRIMARY KEY (id),
  CONSTRAINT wager_transactions_provider_external_uq UNIQUE (provider_id, external_transaction_id),
  CONSTRAINT wager_transactions_provider_key_uq UNIQUE (provider_id, idempotency_key),
  CONSTRAINT wager_transactions_wallet_fk FOREIGN KEY (wallet_id) REFERENCES wallets (id),
  CONSTRAINT wager_transactions_reference_fk FOREIGN KEY (reference_transaction_id) REFERENCES wager_transactions (id),
  CONSTRAINT wager_transactions_status_ck CHECK (status IN ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
  CONSTRAINT wager_transactions_kind_ck CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
  CONSTRAINT wager_transactions_system_provider_ck CHECK ((kind = 'OPENING') = (provider_id = '__system__')),
  CONSTRAINT wager_transactions_reference_required_ck CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
  CONSTRAINT wager_transactions_reference_allowed_ck CHECK (kind IN ('WIN', 'LOSS', 'REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NULL),
  CONSTRAINT wager_transactions_reversal_resolved_ck CHECK (NOT (kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED') OR reference_transaction_id IS NOT NULL),
  CONSTRAINT wager_transactions_self_reference_ck CHECK (reference_external_transaction_id IS DISTINCT FROM external_transaction_id),
  CONSTRAINT wager_transactions_amount_ck CHECK ((kind = 'LOSS' AND amount >= 0) OR (kind <> 'LOSS' AND amount > 0)),
  CONSTRAINT wager_transactions_failure_code_ck CHECK ((status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)),
  CONSTRAINT wager_transactions_failed_code_ck CHECK ((status = 'FAILED') = (failure_code = 'PROCESSING_FAILED')),
  CONSTRAINT wager_transactions_failure_code_value_ck CHECK (failure_code IS NULL OR failure_code IN (
    'PLAYER_WALLET_MISMATCH', 'CURRENCY_MISMATCH', 'INSUFFICIENT_FUNDS', 'INSUFFICIENT_FUNDS_FOR_REVERSAL',
    'BALANCE_LIMIT_EXCEEDED', 'REFERENCE_NOT_FOUND', 'REFERENCE_MISMATCH', 'INVALID_REFERENCE_KIND',
    'REFERENCE_NOT_PROCESSED', 'REFERENCE_ALREADY_REVERSED', 'AMOUNT_MISMATCH', 'PROCESSING_FAILED'
  )),
  CONSTRAINT wager_transactions_processed_at_ck CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
  CONSTRAINT wager_transactions_currency_format_ck CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT wager_transactions_balance_snapshot_ck CHECK (
    (balance_snapshot_amount IS NULL) = (balance_snapshot_currency IS NULL)
    AND (balance_snapshot_currency IS NULL OR balance_snapshot_currency ~ '^[A-Z]{3}$')
  )
)`);
    this.addSql(`CREATE UNIQUE INDEX wager_transactions_single_opening_uq
  ON wager_transactions (wallet_id) WHERE kind = 'OPENING'`);
    this.addSql(`CREATE UNIQUE INDEX wager_transactions_single_reversal_uq
  ON wager_transactions (reference_transaction_id)
  WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED'`);
    this.addSql(`CREATE INDEX wager_transactions_pending_ref_idx
  ON wager_transactions (provider_id, reference_external_transaction_id)
  WHERE status = 'PENDING_REFERENCE'`);
    this.addSql(`CREATE INDEX wager_transactions_round_idx
  ON wager_transactions (wallet_id, round_id)`);
  }

  override down(): void {
    this.addSql(`DROP INDEX wager_transactions_round_idx`);
    this.addSql(`DROP INDEX wager_transactions_pending_ref_idx`);
    this.addSql(`DROP INDEX wager_transactions_single_reversal_uq`);
    this.addSql(`DROP INDEX wager_transactions_single_opening_uq`);
    this.addSql(`DROP TABLE wager_transactions`);
  }
}
