import { Migration } from '@mikro-orm/migrations';

export class Migration20260101000000 extends Migration {
  override up(): void {
    this.addSql('create table wallets (id uuid primary key);');
  }

  override down(): void {
    this.addSql('drop table wallets;');
  }
}
