import { Migration } from '@mikro-orm/migrations';

export class Migration0004IdempotencyAndInbox extends Migration {
  override up(): void {
    this.addSql(`CREATE TABLE idempotency_records (
  provider_id text NOT NULL,
  idempotency_key text NOT NULL,
  payload_hash char(64) NOT NULL,
  transaction_id uuid,
  http_status smallint NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT idempotency_records_pkey PRIMARY KEY (provider_id, idempotency_key),
  CONSTRAINT idempotency_records_transaction_fk FOREIGN KEY (transaction_id) REFERENCES wager_transactions (id),
  CONSTRAINT idempotency_records_status_ck CHECK (http_status IN (200, 202, 409, 422, 500))
)`);
    this.addSql(`CREATE TABLE inbox_messages (
  consumer_name text NOT NULL,
  message_id text NOT NULL,
  payload_hash char(64) NOT NULL,
  received_at timestamptz NOT NULL,
  processed_at timestamptz,
  CONSTRAINT inbox_messages_pkey PRIMARY KEY (consumer_name, message_id)
)`);
  }

  override down(): void {
    this.addSql(`DROP TABLE inbox_messages`);
    this.addSql(`DROP TABLE idempotency_records`);
  }
}
