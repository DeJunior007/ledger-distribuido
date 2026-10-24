import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const scriptPath = join(repositoryRoot, 'scripts', 'compliance', 'check-non-ts-comments.ts');
const fixturesPath = join(import.meta.dir, 'fixtures', 'non-ts-comments');

function runCheck(fixture: string): { exitCode: number; output: string } {
  const result = Bun.spawnSync(['bun', scriptPath, join(fixturesPath, fixture)], {
    cwd: repositoryRoot,
  });
  return { exitCode: result.exitCode, output: result.stdout.toString() };
}

describe('check-non-ts-comments', () => {
  it('passes a directory without comments', () => {
    const { exitCode, output } = runCheck('ok');

    expect(exitCode).toBe(0);
    expect(output).toStartWith('PASS check-non-ts-comments');
  });

  it('fails every commented file in a directory with comments', () => {
    const { exitCode, output } = runCheck('bad');

    expect(exitCode).toBe(1);
    expect(output).toStartWith('FAIL check-non-ts-comments');
    expect(output).toContain('start.sh:2 comment line starting with #');
    expect(output).toContain('Dockerfile:1 comment line starting with #');
    expect(output).toContain('compose.yml:3 comment line starting with #');
    expect(output).toContain(join('infra', 'prometheus.yaml') + ':1 comment line starting with #');
    expect(output).toContain(join('infra', 'nginx.conf') + ':2 comment line starting with #');
    expect(output).toContain('.env.example:1 comment line starting with #');
    expect(output).toContain('Migration20260101000000.ts:5 SQL comment marker --');
    expect(output).toContain('Migration20260102000000.ts:5 SQL comment marker /*');
  });

  it('does not report the shebang line', () => {
    const { output } = runCheck('bad');

    expect(output).not.toContain('start.sh:1 ');
  });
});
