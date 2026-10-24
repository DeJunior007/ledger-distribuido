import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkNonTsComments, printResult } from './check-non-ts-comments';

const root = process.argv[2] ?? process.cwd();

const checks = [checkNonTsComments(root)];

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
