import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { checkMigrations } from '../../../scripts/compliance/check-migrations';

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const scriptPath = join(repositoryRoot, 'scripts', 'compliance', 'check-migrations.ts');
const fixturesPath = join(import.meta.dir, 'fixtures', 'migrations');
const fixturePattern = '**/Migration*.fixture.ts';
const migrationsPath = 'src/infrastructure/persistence/migrations';

describe('check-migrations', () => {
  it('passes reversible migrations without credential columns', () => {
    const result = checkMigrations(join(fixturesPath, 'ok'), fixturePattern);

    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('reports a migration without down', () => {
    const result = checkMigrations(join(fixturesPath, 'bad'), fixturePattern);

    expect(result.passed).toBe(false);
    expect(result.findings).toContainEqual({
      file: `${migrationsPath}/Migration20260101000000.fixture.ts`,
      line: 3,
      message: 'Migration20260101000000 has no down method',
    });
  });

  it('reports a down that is empty or never calls this.addSql', () => {
    const result = checkMigrations(join(fixturesPath, 'bad'), fixturePattern);

    expect(result.findings).toContainEqual({
      file: `${migrationsPath}/Migration20260102000000.fixture.ts`,
      line: 8,
      message: 'Migration20260102000000.down has no this.addSql call',
    });
    expect(result.findings).toContainEqual({
      file: `${migrationsPath}/Migration20260104000000.fixture.ts`,
      line: 8,
      message: 'Migration20260104000000.down has no this.addSql call',
    });
  });

  it('reports password, password_hash and salt columns', () => {
    const result = checkMigrations(join(fixturesPath, 'bad'), fixturePattern);
    const messages = result.findings.map((finding) => finding.message);

    expect(messages).toContain('migration creates credential column password_hash');
    expect(messages).toContain('migration creates credential column salt');
    expect(messages).toContain('migration creates credential column password');
    expect(result.findings).toHaveLength(6);
  });

  it('exits with code 1 when run against the failing directory', () => {
    const result = Bun.spawnSync(['bun', scriptPath, join(fixturesPath, 'bad'), fixturePattern], {
      cwd: repositoryRoot,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toStartWith('FAIL check-migrations');
  });
});
