import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReport, parseJunit, type StaticReport } from '../../../scripts/compliance/report';

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const scriptPath = join(repositoryRoot, 'scripts', 'compliance', 'report.ts');
const fixturesPath = join(import.meta.dir, 'fixtures', 'report');

const readFixture = (name: string): string => readFileSync(join(fixturesPath, name), 'utf8');
const readStatic = (name: string): StaticReport => JSON.parse(readFixture(name)) as StaticReport;

const runScript = async (
  junit: string,
  staticJson: string,
  summaryPath: string | undefined,
): Promise<{ exitCode: number; stdout: string }> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'GITHUB_STEP_SUMMARY') {
      env[key] = value;
    }
  }
  if (summaryPath !== undefined) {
    env.GITHUB_STEP_SUMMARY = summaryPath;
  }
  const proc = Bun.spawn(
    ['bun', scriptPath, join(fixturesPath, junit), join(fixturesPath, staticJson)],
    { env, stdout: 'pipe', stderr: 'pipe' },
  );
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout };
};

describe('compliance report', () => {
  it('summarizes one suite per test file with the enunciado item as title', () => {
    const suites = parseJunit(readFixture('junit-pass.xml'));

    expect(suites.map((suite) => [suite.file, suite.item, suite.tests, suite.failed])).toEqual([
      ['test/compliance/e14-eliminatory.test.ts', '§14 falhas eliminatórias', 2, 0],
      ['test/compliance/r5-1-no-number-money.test.ts', '§5.1 dinheiro nunca é number', 2, 0],
      [
        'test/compliance/r5-9-schema-guarantees.test.ts',
        'r5-9 constraints named in spec 05 exist and fire',
        5,
        0,
      ],
    ]);
  });

  it('builds one row per C-xx id and one per compliance file', () => {
    const { table, passed } = buildReport(
      readFixture('junit-pass.xml'),
      readStatic('static-pass.json'),
    );
    const lines = table.trimEnd().split('\n');

    expect(passed).toBe(true);
    expect(lines.slice(2, 4)).toEqual([
      '| Item do enunciado | Checagem | Resultado |',
      '|---|---|---|',
    ]);
    expect(lines).toContain('| C-01 | check-non-ts-comments | PASS |');
    expect(lines).toContain('| C-06 | check-dependencies | PASS |');
    expect(lines).toContain(
      '| §14 falhas eliminatórias | test/compliance/e14-eliminatory.test.ts | PASS (2 testes) |',
    );
    expect(lines).toHaveLength(4 + 4 + 3);
  });

  it('marks failing static checks and failing tests', () => {
    const { table, passed } = buildReport(
      readFixture('junit-fail.xml'),
      readStatic('static-fail.json'),
    );

    expect(passed).toBe(false);
    expect(table).toContain('| C-11 | check-dependencies | FAIL (1 achados) |');
    expect(table).toContain(
      '| §14 falhas eliminatórias | test/compliance/e14-eliminatory.test.ts | FAIL (1 de 2 falharam, ex.: never debits the same bet twice) |',
    );
  });

  it('prints the table to the terminal and exits 0 when everything passed', async () => {
    const result = await runScript('junit-pass.xml', 'static-pass.json', undefined);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('| C-04 | check-dependencies | PASS |');
  });

  it('appends the table to GITHUB_STEP_SUMMARY and exits 1 when a row failed', async () => {
    const summaryPath = join(mkdtempSync(join(tmpdir(), 'report-')), 'summary.md');
    writeFileSync(summaryPath, '');

    const result = await runScript('junit-fail.xml', 'static-fail.json', summaryPath);

    expect(result.exitCode).toBe(1);
    expect(readFileSync(summaryPath, 'utf8')).toContain(
      '| C-11 | check-dependencies | FAIL (1 achados) |',
    );
    expect(result.stdout).not.toContain('| C-11 |');
  });
});
