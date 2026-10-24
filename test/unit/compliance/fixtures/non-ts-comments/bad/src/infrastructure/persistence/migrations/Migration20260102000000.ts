import { Migration } from '@mikro-orm/migrations';

export class Migration20260102000000 extends Migration {
  override up(): void {
    this.addSql('/* ledger */ create table ledger_entries (id uuid primary key);');
  }

  override down(): void {
    this.addSql('drop table ledger_entries;');
  }
}
