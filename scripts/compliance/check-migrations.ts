import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import ts from 'typescript';
import type { ComplianceCheckResult, ComplianceFinding } from './check-non-ts-comments';
import { printResult } from './check-non-ts-comments';

const DEFAULT_PATTERN = 'src/infrastructure/persistence/migrations/**/Migration*.ts';

const REQUIRED_METHODS = ['up', 'down'] as const;

const CREDENTIAL_COLUMN = new RegExp(
  String.raw`(?:^|[(,]|\badd\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?|\brename\s+(?:column\s+)?(?:"[^"]+"|\w+)\s+to\s+)\s*"?(password|password_hash|salt)"?(?![\w$"])`,
  'i',
);

function toPosixPath(path: string): string {
  return path.split(sep).join('/');
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function isAddSqlCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
    node.expression.name.text === 'addSql'
  );
}

function collectAddSqlCalls(node: ts.Node): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (child: ts.Node): void => {
    if (isAddSqlCall(child)) {
      calls.push(child);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return calls;
}

function sqlTextOf(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ');
  }
  return undefined;
}

function findMethod(
  declaration: ts.ClassDeclaration,
  name: string,
): ts.MethodDeclaration | undefined {
  return declaration.members.find(
    (member): member is ts.MethodDeclaration =>
      ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === name,
  );
}

function checkClass(
  source: ts.SourceFile,
  relativePath: string,
  declaration: ts.ClassDeclaration,
): ComplianceFinding[] {
  const findings: ComplianceFinding[] = [];
  const className = declaration.name?.text ?? 'anonymous class';
  for (const methodName of REQUIRED_METHODS) {
    const method = findMethod(declaration, methodName);
    if (method === undefined) {
      findings.push({
        file: relativePath,
        line: lineOf(source, declaration),
        message: `${className} has no ${methodName} method`,
      });
    } else if (method.body === undefined || collectAddSqlCalls(method.body).length === 0) {
      findings.push({
        file: relativePath,
        line: lineOf(source, method),
        message: `${className}.${methodName} has no this.addSql call`,
      });
    }
  }
  return findings;
}

function checkCredentialColumns(source: ts.SourceFile, relativePath: string): ComplianceFinding[] {
  const findings: ComplianceFinding[] = [];
  for (const call of collectAddSqlCalls(source)) {
    for (const argument of call.arguments) {
      const text = sqlTextOf(argument);
      const match = text === undefined ? null : CREDENTIAL_COLUMN.exec(text);
      if (match?.[1] !== undefined) {
        findings.push({
          file: relativePath,
          line: lineOf(source, argument),
          message: `migration creates credential column ${match[1].toLowerCase()}`,
        });
      }
    }
  }
  return findings;
}

function scanFile(root: string, relativePath: string): ComplianceFinding[] {
  const source = ts.createSourceFile(
    relativePath,
    readFileSync(join(root, relativePath), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const classes = source.statements.filter(ts.isClassDeclaration);
  if (classes.length === 0) {
    return [{ file: relativePath, line: 1, message: 'migration file declares no class' }];
  }
  return [
    ...classes.flatMap((declaration) => checkClass(source, relativePath, declaration)),
    ...checkCredentialColumns(source, relativePath),
  ];
}

export function checkMigrations(root: string, pattern = DEFAULT_PATTERN): ComplianceCheckResult {
  const files = [...new Bun.Glob(pattern).scanSync({ cwd: root })].map(toPosixPath).sort();
  const findings = files.flatMap((relativePath) => scanFile(root, relativePath));
  return {
    name: 'check-migrations',
    ids: ['C-09', 'C-11'],
    passed: findings.length === 0,
    findings,
  };
}

if (import.meta.main) {
  const result = checkMigrations(process.argv[2] ?? process.cwd(), process.argv[3]);
  printResult(result);
  process.exit(result.passed ? 0 : 1);
}
