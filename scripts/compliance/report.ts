import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ComplianceCheckResult } from './check-non-ts-comments';

export interface StaticReport {
  readonly passed: boolean;
  readonly checks: readonly ComplianceCheckResult[];
}

export interface SuiteSummary {
  readonly file: string;
  readonly item: string;
  readonly tests: number;
  readonly failed: number;
  readonly skipped: number;
  readonly firstFailure: string | undefined;
}

export interface ReportRow {
  readonly item: string;
  readonly check: string;
  readonly result: string;
  readonly passed: boolean;
}

interface OpenSuite {
  readonly file: string;
  readonly nestedNames: string[];
  tests: number;
  failed: number;
  skipped: number;
  firstFailure: string | undefined;
}

const TAG_PATTERN = /<(\/?)(testsuite|testcase|failure|error|skipped)\b([^>]*?)(\/?)>/g;
const ATTRIBUTE_PATTERN = /([\w:-]+)="([^"]*)"/g;
const FILE_SUFFIX = '.test.ts';

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseAttributes(raw: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of raw.matchAll(ATTRIBUTE_PATTERN)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) {
      attributes.set(name, decodeEntities(value));
    }
  }
  return attributes;
}

function fileLabel(file: string): string {
  const base = file.split('/').pop() ?? file;
  return base.endsWith(FILE_SUFFIX) ? base.slice(0, -FILE_SUFFIX.length) : base;
}

export function parseJunit(xml: string): SuiteSummary[] {
  const summaries: SuiteSummary[] = [];
  let root: OpenSuite | undefined;
  let depth = 0;
  let currentTestName = '';
  let currentTestFailed = false;
  let currentTestSkipped = false;
  let insideTest = false;

  for (const match of xml.matchAll(TAG_PATTERN)) {
    const [, closing, tag, rawAttributes, selfClosing] = match;
    const attributes = parseAttributes(rawAttributes ?? '');
    const isClosing = closing === '/';
    const isSelfClosing = selfClosing === '/';

    if (tag === 'testsuite') {
      if (isClosing) {
        depth -= 1;
        if (depth === 0 && root !== undefined) {
          summaries.push({
            file: root.file,
            item: root.nestedNames[0] ?? fileLabel(root.file),
            tests: root.tests,
            failed: root.failed,
            skipped: root.skipped,
            firstFailure: root.firstFailure,
          });
          root = undefined;
        }
      } else {
        const name = attributes.get('name') ?? '';
        if (root === undefined) {
          root = {
            file: attributes.get('file') ?? name,
            nestedNames: [],
            tests: 0,
            failed: 0,
            skipped: 0,
            firstFailure: undefined,
          };
        } else {
          root.nestedNames.push(name);
        }
        depth += isSelfClosing ? 0 : 1;
        if (isSelfClosing && depth === 0 && root.nestedNames.length === 0) {
          root = undefined;
        }
      }
    } else if (tag === 'testcase') {
      if (!isClosing && root !== undefined) {
        root.tests += 1;
        currentTestName = attributes.get('name') ?? '';
        currentTestFailed = false;
        currentTestSkipped = false;
        insideTest = !isSelfClosing;
      } else if (isClosing) {
        insideTest = false;
      }
    } else if (!isClosing && insideTest && root !== undefined) {
      if (tag === 'skipped' && !currentTestSkipped) {
        currentTestSkipped = true;
        root.skipped += 1;
      } else if ((tag === 'failure' || tag === 'error') && !currentTestFailed) {
        currentTestFailed = true;
        root.failed += 1;
        root.firstFailure ??= currentTestName;
      }
    }
  }

  return summaries;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function verdict(passed: boolean): string {
  return passed ? 'PASS' : 'FAIL';
}

export function buildRows(
  staticReport: StaticReport,
  suites: readonly SuiteSummary[],
): ReportRow[] {
  const rows: ReportRow[] = [];

  const byId = new Map<string, ComplianceCheckResult[]>();
  for (const check of staticReport.checks) {
    for (const id of check.ids) {
      byId.set(id, [...(byId.get(id) ?? []), check]);
    }
  }
  for (const [id, checks] of [...byId.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const passed = checks.every((check) => check.passed);
    const findings = checks.reduce((total, check) => total + check.findings.length, 0);
    rows.push({
      item: id,
      check: checks.map((check) => check.name).join(', '),
      result: `${verdict(passed)}${passed ? '' : ` (${String(findings)} achados)`}`,
      passed,
    });
  }

  for (const suite of suites) {
    const passed = suite.failed === 0 && suite.tests > 0;
    const detail = passed
      ? ` (${String(suite.tests)} testes)`
      : suite.tests === 0
        ? ' (nenhum teste executado)'
        : ` (${String(suite.failed)} de ${String(suite.tests)} falharam, ex.: ${suite.firstFailure ?? ''})`;
    rows.push({
      item: suite.item,
      check: suite.file,
      result: `${verdict(passed)}${detail}`,
      passed,
    });
  }

  return rows;
}

export function renderTable(rows: readonly ReportRow[]): string {
  const lines = [
    '## Conformidade',
    '',
    '| Item do enunciado | Checagem | Resultado |',
    '|---|---|---|',
    ...rows.map(
      (row) => `| ${escapeCell(row.item)} | ${escapeCell(row.check)} | ${escapeCell(row.result)} |`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}

export function buildReport(
  junitXml: string,
  staticReport: StaticReport,
): { readonly table: string; readonly passed: boolean } {
  const rows = buildRows(staticReport, parseJunit(junitXml));
  return {
    table: renderTable(rows),
    passed: rows.length > 0 && rows.every((row) => row.passed) && staticReport.passed,
  };
}

function main(): void {
  const junitPath = process.argv[2] ?? join(process.cwd(), 'compliance.xml');
  const staticPath = process.argv[3] ?? join(process.cwd(), 'compliance-static.json');
  const staticReport = JSON.parse(readFileSync(staticPath, 'utf8')) as StaticReport;
  const { table, passed } = buildReport(readFileSync(junitPath, 'utf8'), staticReport);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath !== undefined && summaryPath !== '') {
    appendFileSync(summaryPath, table);
  } else {
    console.log(table);
  }
  console.log(passed ? 'PASS compliance report' : 'FAIL compliance report');
  process.exit(passed ? 0 : 1);
}

if (import.meta.main) {
  main();
}
