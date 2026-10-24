import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import ts from 'typescript';
import type { ComplianceCheckResult, ComplianceFinding } from './check-non-ts-comments';
import { printResult } from './check-non-ts-comments';

const DEFAULT_PATTERN = 'test/{integration,concurrency,compliance,e2e}/**/*.ts';

const GUARDED_SUITES: readonly string[] = [
  'test/integration/',
  'test/concurrency/',
  'test/compliance/',
  'test/e2e/',
];

const FAKES_SPECIFIER = /(?:^|\/)support\/fakes(?:\/|$)/;

function toPosixPath(path: string): string {
  return path.split(sep).join('/');
}

function isGuarded(relativePath: string): boolean {
  return GUARDED_SUITES.some((suite) => relativePath.startsWith(suite));
}

function isMockModuleCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'mock' &&
    callee.name.text === 'module'
  );
}

function isSpyOnCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  return (
    (ts.isIdentifier(callee) && callee.text === 'spyOn') ||
    (ts.isPropertyAccessExpression(callee) && callee.name.text === 'spyOn')
  );
}

function importedSpecifier(node: ts.Node): ts.Expression | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier;
  }
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    return node.moduleReference.expression;
  }
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
  ) {
    return node.arguments[0];
  }
  return undefined;
}

function violationOf(node: ts.Node): string | undefined {
  const specifier = importedSpecifier(node);
  if (
    specifier !== undefined &&
    ts.isStringLiteralLike(specifier) &&
    FAKES_SPECIFIER.test(specifier.text)
  ) {
    return `import of test/support/fakes (${specifier.text})`;
  }
  if (ts.isCallExpression(node) && isMockModuleCall(node)) {
    return 'mock.module( is forbidden outside test/unit';
  }
  if (ts.isCallExpression(node) && isSpyOnCall(node)) {
    return 'spyOn( is forbidden outside test/unit';
  }
  return undefined;
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
    const message = violationOf(node);
    if (message !== undefined) {
      findings.push({
        file: relativePath,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        message,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

export function checkTestMocks(root: string, pattern = DEFAULT_PATTERN): ComplianceCheckResult {
  const files = [...new Bun.Glob(pattern).scanSync({ cwd: root })]
    .map(toPosixPath)
    .filter(isGuarded)
    .sort();
  const findings = files.flatMap((relativePath) => scanFile(root, relativePath));
  return {
    name: 'check-test-mocks',
    ids: ['C-10'],
    passed: findings.length === 0,
    findings,
  };
}

if (import.meta.main) {
  const result = checkTestMocks(process.argv[2] ?? process.cwd(), process.argv[3]);
  printResult(result);
  process.exit(result.passed ? 0 : 1);
}
