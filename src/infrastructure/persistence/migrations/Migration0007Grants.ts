import { Migration } from '@mikro-orm/migrations';

export class Migration0007Grants extends Migration {
  override up(): void {
    this.addSql(`GRANT USAGE ON SCHEMA public TO jungle_app`);
    this
      .addSql(`GRANT SELECT ON wallets, house_accounts, wager_transactions, ledger_entries, wallet_ledger_entries,
  idempotency_records, inbox_messages, outbox_messages, pending_reference_retries,
  scheduled_jobs, reconciliation_runs TO jungle_app`);
    this
      .addSql(`GRANT INSERT ON wallets, house_accounts, wager_transactions, ledger_entries, idempotency_records,
  inbox_messages, outbox_messages, pending_reference_retries, reconciliation_runs TO jungle_app`);
    this.addSql(`GRANT UPDATE (balance, version, updated_at) ON wallets TO jungle_app`);
    this
      .addSql(`GRANT UPDATE (status, failure_code, reference_transaction_id, processed_at, balance_snapshot_amount, balance_snapshot_currency, updated_at)
  ON wager_transactions TO jungle_app`);
    this.addSql(
      `GRANT UPDATE (http_status, response_body, updated_at) ON idempotency_records TO jungle_app`,
    );
    this.addSql(`GRANT UPDATE (processed_at) ON inbox_messages TO jungle_app`);
    this
      .addSql(`GRANT UPDATE (attempts, permanent_failures, next_attempt_at, locked_until, locked_by, published_at, parked_at, last_error_code)
  ON outbox_messages TO jungle_app`);
    this
      .addSql(`GRANT UPDATE (attempts, consecutive_errors, next_attempt_at, locked_until, locked_by, resolved_at)
  ON pending_reference_retries TO jungle_app`);
    this.addSql(
      `GRANT UPDATE (locked_until, locked_by, last_run_at) ON scheduled_jobs TO jungle_app`,
    );
  }

  override down(): void {
    this
      .addSql(`REVOKE ALL ON wallets, house_accounts, wager_transactions, ledger_entries, wallet_ledger_entries,
  idempotency_records, inbox_messages, outbox_messages, pending_reference_retries,
  scheduled_jobs, reconciliation_runs FROM jungle_app`);
    this.addSql(`REVOKE USAGE ON SCHEMA public FROM jungle_app`);
  }
}
