import { Migration } from '@mikro-orm/migrations';

export class Migration0006Guards extends Migration {
  override up(): void {
    this.addSql(`CREATE FUNCTION jungle_guard_ledger_entries() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only (%)', TG_OP USING ERRCODE = 'JG001';
END;
$$`);
    this.addSql(`CREATE TRIGGER ledger_entries_immutable_row
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION jungle_guard_ledger_entries()`);
    this.addSql(`CREATE TRIGGER ledger_entries_immutable_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION jungle_guard_ledger_entries()`);
    this.addSql(`CREATE FUNCTION jungle_check_wallet_ledger_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'wallet % must start at version 1', NEW.id USING ERRCODE = 'JG002';
    END IF;
    IF NEW.balance > 0 AND NOT EXISTS (
      SELECT 1
      FROM ledger_entries e
      JOIN wager_transactions t ON t.id = e.transaction_id
      WHERE e.account_kind = 'WALLET'
        AND e.wallet_id = NEW.id
        AND e.wallet_version = 1
        AND e.balance_before = 0
        AND e.balance_after = NEW.balance
        AND t.kind = 'OPENING'
    ) THEN
      RAISE EXCEPTION 'wallet % opened with balance but without opening entry', NEW.id USING ERRCODE = 'JG002';
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.player_id <> OLD.player_id OR NEW.currency <> OLD.currency OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'wallet % identity columns are immutable', NEW.id USING ERRCODE = 'JG002';
  END IF;

  IF NEW.balance = OLD.balance THEN
    IF NEW.version <> OLD.version THEN
      RAISE EXCEPTION 'wallet % version changed without balance change', NEW.id USING ERRCODE = 'JG002';
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.version <> OLD.version + 1 OR NOT EXISTS (
    SELECT 1
    FROM ledger_entries e
    WHERE e.account_kind = 'WALLET'
      AND e.wallet_id = NEW.id
      AND e.wallet_version = NEW.version
      AND e.balance_before = OLD.balance
      AND e.balance_after = NEW.balance
  ) THEN
    RAISE EXCEPTION 'wallet % balance changed without matching ledger entry', NEW.id USING ERRCODE = 'JG002';
  END IF;
  RETURN NULL;
END;
$$`);
    this.addSql(`CREATE CONSTRAINT TRIGGER wallets_ledger_chain
  AFTER INSERT OR UPDATE ON wallets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION jungle_check_wallet_ledger_chain()`);
    this.addSql(`CREATE FUNCTION jungle_check_ledger_entry_consistency() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  tx_status text;
  tx_kind text;
  tx_wallet uuid;
  current_version integer;
  current_currency text;
BEGIN
  SELECT status, kind, wallet_id INTO tx_status, tx_kind, tx_wallet
  FROM wager_transactions
  WHERE id = NEW.transaction_id;

  IF tx_status IS DISTINCT FROM 'PROCESSED' OR tx_kind = 'LOSS' THEN
    RAISE EXCEPTION 'ledger entry % belongs to a transaction that is not a processed movement', NEW.id USING ERRCODE = 'JG003';
  END IF;

  IF NEW.account_kind = 'WALLET' THEN
    SELECT version, currency INTO current_version, current_currency
    FROM wallets
    WHERE id = NEW.wallet_id;
    IF NEW.wallet_id <> tx_wallet OR NEW.wallet_version > current_version OR NEW.currency <> current_currency THEN
      RAISE EXCEPTION 'ledger entry % does not match its wallet', NEW.id USING ERRCODE = 'JG003';
    END IF;
  END IF;
  RETURN NULL;
END;
$$`);
    this.addSql(`CREATE CONSTRAINT TRIGGER ledger_entries_consistency
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION jungle_check_ledger_entry_consistency()`);
    this.addSql(`CREATE FUNCTION jungle_check_ledger_transaction_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  tx record;
  wallet_count integer;
  house_count integer;
  net numeric;
  mismatched integer;
  wallet_direction text;
  reference_direction text;
  expected_direction text;
  house_purpose text;
  house_currency text;
  expected_purpose text;
BEGIN
  SELECT id, kind, amount, currency, reference_transaction_id INTO tx
  FROM wager_transactions
  WHERE id = NEW.transaction_id;

  SELECT
    count(*) FILTER (WHERE account_kind = 'WALLET'),
    count(*) FILTER (WHERE account_kind = 'HOUSE'),
    coalesce(sum(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0),
    count(*) FILTER (WHERE amount <> tx.amount OR currency <> tx.currency)
  INTO wallet_count, house_count, net, mismatched
  FROM ledger_entries
  WHERE transaction_id = NEW.transaction_id;

  IF wallet_count <> 1 OR house_count <> 1 OR net <> 0 OR mismatched <> 0 THEN
    RAISE EXCEPTION 'transaction % is not a balanced double entry', NEW.transaction_id USING ERRCODE = 'JG004';
  END IF;

  SELECT direction INTO wallet_direction
  FROM ledger_entries
  WHERE transaction_id = NEW.transaction_id AND account_kind = 'WALLET';

  SELECT h.purpose, h.currency INTO house_purpose, house_currency
  FROM ledger_entries e
  JOIN house_accounts h ON h.id = e.house_account_id
  WHERE e.transaction_id = NEW.transaction_id AND e.account_kind = 'HOUSE';

  expected_purpose := CASE WHEN tx.kind = 'OPENING' THEN 'FUNDING' ELSE 'GAMING' END;

  IF house_currency IS DISTINCT FROM tx.currency OR house_purpose IS DISTINCT FROM expected_purpose THEN
    RAISE EXCEPTION 'transaction % uses the wrong house account', NEW.transaction_id USING ERRCODE = 'JG004';
  END IF;

  IF tx.kind = 'ROLLBACK' THEN
    SELECT direction INTO reference_direction
    FROM ledger_entries
    WHERE transaction_id = tx.reference_transaction_id AND account_kind = 'WALLET';
    expected_direction := CASE reference_direction WHEN 'DEBIT' THEN 'CREDIT' WHEN 'CREDIT' THEN 'DEBIT' END;
  ELSE
    expected_direction := CASE tx.kind WHEN 'BET' THEN 'DEBIT' ELSE 'CREDIT' END;
  END IF;

  IF wallet_direction IS DISTINCT FROM expected_direction THEN
    RAISE EXCEPTION 'transaction % moves the wallet in the wrong direction', NEW.transaction_id USING ERRCODE = 'JG004';
  END IF;
  RETURN NULL;
END;
$$`);
    this.addSql(`CREATE CONSTRAINT TRIGGER ledger_entries_transaction_balance
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION jungle_check_ledger_transaction_balance()`);
    this.addSql(`CREATE FUNCTION jungle_guard_wager_transactions() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'wager_transactions rows cannot be removed' USING ERRCODE = 'JG005';
  END IF;
  IF OLD.status <> 'PENDING_REFERENCE' THEN
    RAISE EXCEPTION 'transaction % is terminal', OLD.id USING ERRCODE = 'JG005';
  END IF;
  IF NEW.status NOT IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
    RAISE EXCEPTION 'transaction % can only leave PENDING_REFERENCE to a terminal status', OLD.id USING ERRCODE = 'JG005';
  END IF;
  IF ROW(NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
         NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
         NEW.reference_external_transaction_id, NEW.correlation_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
         OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
         OLD.reference_external_transaction_id, OLD.correlation_id, OLD.created_at) THEN
    RAISE EXCEPTION 'transaction % business columns are immutable', OLD.id USING ERRCODE = 'JG005';
  END IF;
  RETURN NEW;
END;
$$`);
    this.addSql(`CREATE TRIGGER wager_transactions_guard_row
  BEFORE UPDATE OR DELETE ON wager_transactions
  FOR EACH ROW EXECUTE FUNCTION jungle_guard_wager_transactions()`);
    this.addSql(`CREATE TRIGGER wager_transactions_guard_truncate
  BEFORE TRUNCATE ON wager_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION jungle_guard_wager_transactions()`);
    this.addSql(`CREATE FUNCTION jungle_guard_wallets_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wallets cannot be removed (%)', TG_OP USING ERRCODE = 'JG006';
END;
$$`);
    this.addSql(`CREATE TRIGGER wallets_no_delete_row
  BEFORE DELETE ON wallets
  FOR EACH ROW EXECUTE FUNCTION jungle_guard_wallets_delete()`);
    this.addSql(`CREATE TRIGGER wallets_no_delete_truncate
  BEFORE TRUNCATE ON wallets
  FOR EACH STATEMENT EXECUTE FUNCTION jungle_guard_wallets_delete()`);
    this.addSql(`CREATE FUNCTION jungle_guard_idempotency_records() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'idempotency records cannot be removed' USING ERRCODE = 'JG007';
  END IF;
  IF OLD.http_status <> 202 THEN
    RAISE EXCEPTION 'idempotency record %/% is final', OLD.provider_id, OLD.idempotency_key USING ERRCODE = 'JG007';
  END IF;
  IF NEW.http_status NOT IN (200, 422, 500) THEN
    RAISE EXCEPTION 'idempotency record %/% can only resolve to 200, 422 or 500', OLD.provider_id, OLD.idempotency_key USING ERRCODE = 'JG007';
  END IF;
  IF ROW(NEW.provider_id, NEW.idempotency_key, NEW.payload_hash, NEW.transaction_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.provider_id, OLD.idempotency_key, OLD.payload_hash, OLD.transaction_id, OLD.created_at) THEN
    RAISE EXCEPTION 'idempotency record %/% identity is immutable', OLD.provider_id, OLD.idempotency_key USING ERRCODE = 'JG007';
  END IF;
  RETURN NEW;
END;
$$`);
    this.addSql(`CREATE TRIGGER idempotency_records_guard_row
  BEFORE UPDATE OR DELETE ON idempotency_records
  FOR EACH ROW EXECUTE FUNCTION jungle_guard_idempotency_records()`);
    this.addSql(`CREATE TRIGGER idempotency_records_guard_truncate
  BEFORE TRUNCATE ON idempotency_records
  FOR EACH STATEMENT EXECUTE FUNCTION jungle_guard_idempotency_records()`);
  }

  override down(): void {
    this.addSql(`DROP TRIGGER idempotency_records_guard_truncate ON idempotency_records`);
    this.addSql(`DROP TRIGGER idempotency_records_guard_row ON idempotency_records`);
    this.addSql(`DROP TRIGGER wallets_no_delete_truncate ON wallets`);
    this.addSql(`DROP TRIGGER wallets_no_delete_row ON wallets`);
    this.addSql(`DROP TRIGGER wager_transactions_guard_truncate ON wager_transactions`);
    this.addSql(`DROP TRIGGER wager_transactions_guard_row ON wager_transactions`);
    this.addSql(`DROP TRIGGER ledger_entries_transaction_balance ON ledger_entries`);
    this.addSql(`DROP TRIGGER ledger_entries_consistency ON ledger_entries`);
    this.addSql(`DROP TRIGGER wallets_ledger_chain ON wallets`);
    this.addSql(`DROP TRIGGER ledger_entries_immutable_truncate ON ledger_entries`);
    this.addSql(`DROP TRIGGER ledger_entries_immutable_row ON ledger_entries`);
    this.addSql(`DROP FUNCTION jungle_guard_idempotency_records()`);
    this.addSql(`DROP FUNCTION jungle_guard_wallets_delete()`);
    this.addSql(`DROP FUNCTION jungle_guard_wager_transactions()`);
    this.addSql(`DROP FUNCTION jungle_check_ledger_transaction_balance()`);
    this.addSql(`DROP FUNCTION jungle_check_ledger_entry_consistency()`);
    this.addSql(`DROP FUNCTION jungle_check_wallet_ledger_chain()`);
    this.addSql(`DROP FUNCTION jungle_guard_ledger_entries()`);
  }
}
