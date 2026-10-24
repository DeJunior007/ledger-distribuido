import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkDependencies } from './check-dependencies';
import { checkMigrations } from './check-migrations';
import { checkNonTsComments, printResult } from './check-non-ts-comments';
import { checkSqlLiterals } from './check-sql-literals';
import { checkTestMocks } from './check-test-mocks';

const root = process.argv[2] ?? process.cwd();

const checks = [
  checkNonTsComments(root),
  checkDependencies(root),
  checkSqlLiterals(root),
  checkMigrations(root),
  checkTestMocks(root),
];

for (const check of checks) {
  printResult(check);
}

const passed = checks.every((check) => check.passed);

writeFileSync(
  join(root, 'compliance-static.json'),
  `${JSON.stringify({ passed, checks }, null, 2)}\n`,
);

console.log(passed ? 'PASS check:compliance' : 'FAIL check:compliance');

process.exit(passed ? 0 : 1);
