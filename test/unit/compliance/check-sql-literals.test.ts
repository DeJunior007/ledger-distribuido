import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { checkSqlLiterals } from '../../../scripts/compliance/check-sql-literals';

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const scriptPath = join(repositoryRoot, 'scripts', 'compliance', 'check-sql-literals.ts');
const fixturesPath = join(import.meta.dir, 'fixtures', 'sql-literals');
const fixturePattern = '**/*.fixture.ts';
const repositoryFile = 'src/infrastructure/persistence/forbidden.repository.fixture.ts';

describe('check-sql-literals', () => {
  it('passes ordinary SQL, prose that mentions SQL words and excluded folders', () => {
    const result = checkSqlLiterals(join(fixturesPath, 'ok'), fixturePattern);

    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('reports every forbidden statement in src and scripts', () => {
    const result = checkSqlLiterals(join(fixturesPath, 'bad'), fixturePattern);

    expect(result.passed).toBe(false);
    expect(result.findings).toEqual([
      { file: 'scripts/reset-queues.fixture.ts', line: 1, message: 'TRUNCATE is forbidden' },
      { file: repositoryFile, line: 3, message: 'UPDATE ledger_entries is forbidden' },
      { file: repositoryFile, line: 5, message: 'DELETE FROM is forbidden' },
      { file: repositoryFile, line: 7, message: 'TRUNCATE is forbidden' },
      { file: repositoryFile, line: 9, message: 'LOCK TABLE is forbidden' },
      { file: repositoryFile, line: 11, message: 'pg_advisory_lock is forbidden' },
      { file: repositoryFile, line: 13, message: 'pg_advisory_xact_lock is forbidden' },
      { file: repositoryFile, line: 15, message: 'FOR UPDATE without WHERE is forbidden' },
      { file: repositoryFile, line: 17, message: 'DELETE FROM is forbidden' },
      { file: repositoryFile, line: 19, message: 'DELETE FROM is forbidden' },
    ]);
  });

  it('ignores migrations and the compliance scripts', () => {
    const result = checkSqlLiterals(join(fixturesPath, 'ok'), fixturePattern);
    const files = result.findings.map((finding) => finding.file);

    expect(files.some((file) => file.includes('/migrations/'))).toBe(false);
    expect(files.some((file) => file.startsWith('scripts/compliance/'))).toBe(false);
  });

  it('exits with code 1 when run against the failing directory', () => {
    const result = Bun.spawnSync(['bun', scriptPath, join(fixturesPath, 'bad'), fixturePattern], {
      cwd: repositoryRoot,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toStartWith('FAIL check-sql-literals');
  });
});
