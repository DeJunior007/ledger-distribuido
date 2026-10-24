import { Migration } from '@mikro-orm/migrations';

export class Migration20260102000000 extends Migration {
  override up(): void {
    this.addSql(`CREATE TABLE house_accounts (id uuid PRIMARY KEY)`);
  }

  override down(): void {}
}
