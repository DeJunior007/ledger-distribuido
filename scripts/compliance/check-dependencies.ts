import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ComplianceCheckResult, ComplianceFinding } from './check-non-ts-comments';
import { printResult } from './check-non-ts-comments';

const FORBIDDEN_PACKAGES: readonly string[] = [
  'prisma',
  'typeorm',
  'drizzle-orm',
  'sequelize',
  'knex',
  'bcrypt',
  'argon2',
  'passport-local',
  'jsonwebtoken',
  'lru-cache',
  'node-cache',
  'cache-manager',
  '@nestjs/cache-manager',
  'keyv',
  'ioredis',
  'decimal.js',
  'big.js',
  'bignumber.js',
];

const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findKeyLine(lines: readonly string[], key: string, fromIndex: number): number {
  const prefix = `${JSON.stringify(key)}:`;
  const index = lines.findIndex(
    (line, position) => position >= fromIndex && line.trimStart().startsWith(prefix),
  );
  return index === -1 ? fromIndex : index;
}

export function checkDependencies(
  root: string,
  manifestName = 'package.json',
): ComplianceCheckResult {
  const text = readFileSync(join(root, manifestName), 'utf8');
  const lines = text.split(/\r?\n/);
  const manifest: unknown = JSON.parse(text);
  const findings: ComplianceFinding[] = [];
  for (const section of DEPENDENCY_SECTIONS) {
    const entries: unknown = isRecord(manifest) ? manifest[section] : undefined;
    if (!isRecord(entries)) {
      continue;
    }
    const sectionIndex = findKeyLine(lines, section, 0);
    for (const packageName of Object.keys(entries).sort()) {
      if (FORBIDDEN_PACKAGES.includes(packageName)) {
        findings.push({
          file: manifestName,
          line: findKeyLine(lines, packageName, sectionIndex) + 1,
          message: `forbidden package ${packageName} in ${section}`,
        });
      }
    }
  }
  return {
    name: 'check-dependencies',
    ids: ['C-04', 'C-06', 'C-11'],
    passed: findings.length === 0,
    findings,
  };
}

if (import.meta.main) {
  const result = checkDependencies(process.argv[2] ?? process.cwd(), process.argv[3]);
  printResult(result);
  process.exit(result.passed ? 0 : 1);
}
