import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import ts from 'typescript';
import type { ComplianceCheckResult, ComplianceFinding } from './check-non-ts-comments';
import { printResult } from './check-non-ts-comments';

const DEFAULT_PATTERN = '{src,scripts}/**/*.ts';

const EXCLUDED_PREFIXES: readonly string[] = [
  'src/infrastructure/persistence/migrations/',
  'scripts/compliance/',
];

const TEMPLATE_PLACEHOLDER = 'placeholder';

const STATEMENT_START = String.raw`(?:^|;)\s*`;

const IDENTIFIER = String.raw`(?:"[^"]+"|[a-z_][\w$]*)(?:\.(?:"[^"]+"|[a-z_][\w$]*))?`;

interface SqlRule {
  readonly pattern: RegExp;
  readonly message: string;
}

const STATEMENT_RULES: readonly SqlRule[] = [
  {
    pattern: new RegExp(
      String.raw`${STATEMENT_START}update\s+(?:only\s+)?(?:(?:"[^"]+"|[a-z_][\w$]*)\.)?"?ledger_entries"?(?![\w$])`,
      'i',
    ),
    message: 'UPDATE ledger_entries is forbidden',
  },
  {
    pattern: new RegExp(
      String.raw`${STATEMENT_START}delete\s+from\s+(?:only\s+)?${IDENTIFIER}`,
      'i',
    ),
    message: 'DELETE FROM is forbidden',
  },
  {
    pattern: new RegExp(
      String.raw`${STATEMENT_START}truncate\s+(?:table\s+)?(?:only\s+)?${IDENTIFIER}`,
      'i',
    ),
    message: 'TRUNCATE is forbidden',
  },
];

const ANYWHERE_RULES: readonly SqlRule[] = [
  { pattern: /\block\s+table\b/i, message: 'LOCK TABLE is forbidden' },
  { pattern: /\bpg_advisory_lock/i, message: 'pg_advisory_lock is forbidden' },
  { pattern: /\bpg_advisory_xact_lock/i, message: 'pg_advisory_xact_lock is forbidden' },
];

const FOR_UPDATE = /\bfor\s+update\b/i;

const WHERE = /\bwhere\b/i;

function toPosixPath(path: string): string {
  return path.split(sep).join('/');
}

function isExcluded(relativePath: string): boolean {
  return EXCLUDED_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    return [
      node.head.text,
      ...node.templateSpans.map((span) => `${TEMPLATE_PLACEHOLDER}${span.literal.text}`),
    ].join('');
  }
  return undefined;
}

function findSqlViolations(text: string): string[] {
  const messages = [
    ...STATEMENT_RULES.filter((rule) => rule.pattern.test(text)),
    ...ANYWHERE_RULES.filter((rule) => rule.pattern.test(text)),
  ].map((rule) => rule.message);
  if (FOR_UPDATE.test(text) && !WHERE.test(text)) {
    messages.push('FOR UPDATE without WHERE is forbidden');
  }
  return messages;
}

function scanFile(root: string, relativePath: string): ComplianceFinding[] {
  const source = ts.createSourceFile(
    relativePath,
    readFileSync(join(root, relativePath), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const findings: ComplianceFinding[] = [];
  const visit = (node: ts.Node): void => {
    const text = literalText(node);
    if (text === undefined) {
      ts.forEachChild(node, visit);
      return;
    }
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    for (const message of findSqlViolations(text)) {
      findings.push({ file: relativePath, line, message });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

export function checkSqlLiterals(root: string, pattern = DEFAULT_PATTERN): ComplianceCheckResult {
  const files = [...new Bun.Glob(pattern).scanSync({ cwd: root })]
    .map(toPosixPath)
    .filter((relativePath) => !isExcluded(relativePath))
    .sort();
  const findings = files.flatMap((relativePath) => scanFile(root, relativePath));
  return {
    name: 'check-sql-literals',
    ids: ['C-07', 'C-08'],
    passed: findings.length === 0,
    findings,
  };
}

if (import.meta.main) {
  const result = checkSqlLiterals(process.argv[2] ?? process.cwd(), process.argv[3]);
  printResult(result);
  process.exit(result.passed ? 0 : 1);
}
