import { Migration } from '@mikro-orm/migrations';

export class Migration20260101000000 extends Migration {
  override up(): void {
    this.addSql(`CREATE TABLE wallets (id uuid PRIMARY KEY)`);
  }
}
