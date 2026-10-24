import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { checkTestMocks } from '../../../scripts/compliance/check-test-mocks';

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const scriptPath = join(repositoryRoot, 'scripts', 'compliance', 'check-test-mocks.ts');
const fixturesPath = join(import.meta.dir, 'fixtures', 'test-mocks');
const fixturePattern = '**/*.fixture.ts';

describe('check-test-mocks', () => {
  it('allows mocks and fakes in test/unit and plain text that names them', () => {
    const result = checkTestMocks(join(fixturesPath, 'ok'), fixturePattern);

    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('reports mocks, spies and fakes in every suite that needs real dependencies', () => {
    const result = checkTestMocks(join(fixturesPath, 'bad'), fixturePattern);

    expect(result.passed).toBe(false);
    expect(result.findings).toEqual([
      {
        file: 'test/compliance/r5-1.fixture.ts',
        line: 2,
        message: 'import of test/support/fakes (../support/fakes/in-memory-wallet.repository)',
      },
      {
        file: 'test/concurrency/debits.fixture.ts',
        line: 6,
        message: 'spyOn( is forbidden outside test/unit',
      },
      {
        file: 'test/e2e/smoke.fixture.ts',
        line: 5,
        message: 'import of test/support/fakes (@test/support/fakes/fixed-clock)',
      },
      {
        file: 'test/integration/wallet.fixture.ts',
        line: 3,
        message: 'mock.module( is forbidden outside test/unit',
      },
    ]);
  });

  it('exits with code 1 when run against the failing directory', () => {
    const result = Bun.spawnSync(['bun', scriptPath, join(fixturesPath, 'bad'), fixturePattern], {
      cwd: repositoryRoot,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toStartWith('FAIL check-test-mocks');
  });
});
