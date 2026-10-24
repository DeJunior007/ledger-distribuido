import { Migration } from '@mikro-orm/migrations';

export class Migration20260101000000 extends Migration {
  override up(): void {
    this.addSql(
      `CREATE TABLE wallets (id uuid PRIMARY KEY, player_id text NOT NULL, password_rotated_at timestamptz)`,
    );
    this.addSql(`CREATE TABLE house_accounts (id uuid PRIMARY KEY)`);
  }

  override down(): void {
    this.addSql(`DROP TABLE house_accounts`);
    this.addSql(`DROP TABLE wallets`);
  }
}
