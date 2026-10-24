import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

export interface ComplianceFinding {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export interface ComplianceCheckResult {
  readonly name: string;
  readonly ids: readonly string[];
  readonly passed: boolean;
  readonly findings: readonly ComplianceFinding[];
}

const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'docs',
  'spikes',
  'coverage',
  'load-test-results',
]);

const SKIPPED_PATHS = new Set([join('test', 'unit', 'compliance', 'fixtures')]);

const MIGRATIONS_PATH = join('src', 'infrastructure', 'persistence', 'migrations');

const HASH_COMMENT_LINE = /^\s*#/;

const SQL_COMMENT_MARKERS = ['--', '/*', '*/'];

function isHashCommentedFile(fileName: string): boolean {
  return (
    fileName.endsWith('.sh') ||
    fileName.endsWith('.yml') ||
    fileName.endsWith('.yaml') ||
    fileName.endsWith('.conf') ||
    fileName === '.env.example' ||
    fileName === 'Dockerfile' ||
    fileName.startsWith('Dockerfile.') ||
    fileName.endsWith('.Dockerfile')
  );
}

function isMigrationFile(relativePath: string): boolean {
  return relativePath.startsWith(MIGRATIONS_PATH + sep);
}

function listFiles(root: string, directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    const relativePath = relative(root, absolutePath);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name) && !SKIPPED_PATHS.has(relativePath)) {
        files.push(...listFiles(root, absolutePath));
      }
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

function findHashComments(relativePath: string, lines: readonly string[]): ComplianceFinding[] {
  const findings: ComplianceFinding[] = [];
  lines.forEach((line, index) => {
    const isShebang = index === 0 && line.startsWith('#!');
    if (!isShebang && HASH_COMMENT_LINE.test(line)) {
      findings.push({
        file: relativePath,
        line: index + 1,
        message: 'comment line starting with #',
      });
    }
  });
  return findings;
}

function findSqlComments(relativePath: string, lines: readonly string[]): ComplianceFinding[] {
  const findings: ComplianceFinding[] = [];
  lines.forEach((line, index) => {
    const marker = SQL_COMMENT_MARKERS.find((candidate) => line.includes(candidate));
    if (marker !== undefined) {
      findings.push({
        file: relativePath,
        line: index + 1,
        message: `SQL comment marker ${marker}`,
      });
    }
  });
  return findings;
}

export function checkNonTsComments(root: string): ComplianceCheckResult {
  const findings: ComplianceFinding[] = [];
  for (const relativePath of listFiles(root, root).sort()) {
    const hashCommented = isHashCommentedFile(basename(relativePath));
    const migration = isMigrationFile(relativePath);
    if (!hashCommented && !migration) {
      continue;
    }
    const lines = readFileSync(join(root, relativePath), 'utf8').split(/\r?\n/);
    if (hashCommented) {
      findings.push(...findHashComments(relativePath, lines));
    }
    if (migration) {
      findings.push(...findSqlComments(relativePath, lines));
    }
  }
  return {
    name: 'check-non-ts-comments',
    ids: ['C-01'],
    passed: findings.length === 0,
    findings,
  };
}

export function printResult(result: ComplianceCheckResult): void {
  console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name} (${result.ids.join(', ')})`);
  for (const finding of result.findings) {
    console.log(`  ${finding.file}:${String(finding.line)} ${finding.message}`);
  }
}

if (import.meta.main) {
  const result = checkNonTsComments(process.argv[2] ?? process.cwd());
  printResult(result);
  process.exit(result.passed ? 0 : 1);
}
