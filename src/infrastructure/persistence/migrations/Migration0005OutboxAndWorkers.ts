import { Migration } from '@mikro-orm/migrations';

export class Migration0005OutboxAndWorkers extends Migration {
  override up(): void {
    this.addSql(`CREATE TABLE outbox_messages (
  id uuid NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  permanent_failures integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  locked_until timestamptz,
  locked_by text,
  published_at timestamptz,
  parked_at timestamptz,
  last_error_code text,
  CONSTRAINT outbox_messages_pkey PRIMARY KEY (id),
  CONSTRAINT outbox_messages_counters_ck CHECK (attempts >= 0 AND permanent_failures >= 0)
)`);
    this.addSql(`CREATE INDEX outbox_messages_due_idx
  ON outbox_messages (next_attempt_at) WHERE published_at IS NULL`);
    this.addSql(`CREATE TABLE pending_reference_retries (
  transaction_id uuid NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  consecutive_errors integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL,
  locked_until timestamptz,
  locked_by text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL,
  CONSTRAINT pending_reference_retries_pkey PRIMARY KEY (transaction_id),
  CONSTRAINT pending_reference_retries_transaction_fk FOREIGN KEY (transaction_id) REFERENCES wager_transactions (id),
  CONSTRAINT pending_reference_retries_counters_ck CHECK (attempts >= 0 AND consecutive_errors >= 0)
)`);
    this.addSql(`CREATE INDEX pending_reference_retries_due_idx
  ON pending_reference_retries (next_attempt_at) WHERE resolved_at IS NULL`);
    this.addSql(`CREATE TABLE scheduled_jobs (
  name text NOT NULL,
  locked_until timestamptz,
  locked_by text,
  last_run_at timestamptz,
  CONSTRAINT scheduled_jobs_pkey PRIMARY KEY (name)
)`);
    this.addSql(`INSERT INTO scheduled_jobs (name) VALUES ('global-reconciliation')`);
    this.addSql(`CREATE TABLE reconciliation_runs (
  id uuid NOT NULL,
  scope text NOT NULL,
  wallet_id uuid,
  consistent boolean NOT NULL,
  checked_entries integer NOT NULL,
  stored_amount numeric(32,2),
  calculated_amount numeric(32,2),
  difference_amount numeric(32,2),
  currency char(3),
  first_divergent_version integer,
  details jsonb NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  CONSTRAINT reconciliation_runs_pkey PRIMARY KEY (id),
  CONSTRAINT reconciliation_runs_scope_ck CHECK (scope IN ('WALLET', 'GLOBAL')),
  CONSTRAINT reconciliation_runs_wallet_ck CHECK ((scope = 'WALLET') = (wallet_id IS NOT NULL))
)`);
  }

  override down(): void {
    this.addSql(`DROP TABLE reconciliation_runs`);
    this.addSql(`DROP TABLE scheduled_jobs`);
    this.addSql(`DROP INDEX pending_reference_retries_due_idx`);
    this.addSql(`DROP TABLE pending_reference_retries`);
    this.addSql(`DROP INDEX outbox_messages_due_idx`);
    this.addSql(`DROP TABLE outbox_messages`);
  }
}
