import { Migration } from '@mikro-orm/migrations';

export class Migration20260103000000 extends Migration {
  override up(): void {
    this.addSql(`CREATE TABLE operators (
      id uuid PRIMARY KEY,
      password_hash text NOT NULL
    )`);
    this.addSql(`ALTER TABLE operators ADD COLUMN salt text`);
  }

  override down(): void {
    this.addSql(`DROP TABLE operators`);
  }
}
