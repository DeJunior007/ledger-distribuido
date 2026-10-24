import { Migration } from '@mikro-orm/migrations';

export class Migration20260104000000 extends Migration {
  override up(): void {
    this.addSql(`ALTER TABLE wallets ADD password text`);
  }

  override down(): void {
    const statement = `ALTER TABLE wallets DROP COLUMN password`;
    void statement;
  }
}
