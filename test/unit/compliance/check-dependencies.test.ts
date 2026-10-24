import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { checkDependencies } from '../../../scripts/compliance/check-dependencies';

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const scriptPath = join(repositoryRoot, 'scripts', 'compliance', 'check-dependencies.ts');
const fixturesPath = join(import.meta.dir, 'fixtures', 'dependencies');

const FORBIDDEN_PACKAGES = [
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

describe('check-dependencies', () => {
  it('passes a manifest without forbidden packages', () => {
    const result = checkDependencies(join(fixturesPath, 'ok'));

    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('reports every forbidden package in dependencies and devDependencies', () => {
    const result = checkDependencies(join(fixturesPath, 'bad'));
    const messages = result.findings.map((finding) => finding.message);

    expect(result.passed).toBe(false);
    expect(result.findings).toHaveLength(FORBIDDEN_PACKAGES.length);
    for (const packageName of FORBIDDEN_PACKAGES) {
      expect(
        messages.some((message) => message.startsWith(`forbidden package ${packageName} `)),
      ).toBe(true);
    }
    expect(messages).toContain('forbidden package prisma in devDependencies');
    expect(messages).toContain('forbidden package bcrypt in dependencies');
  });

  it('points each finding at the manifest line of the package', () => {
    const result = checkDependencies(join(fixturesPath, 'bad'));

    expect(result.findings).toContainEqual({
      file: 'package.json',
      line: 7,
      message: 'forbidden package bcrypt in dependencies',
    });
  });

  it('exits with code 1 when run against the failing directory', () => {
    const result = Bun.spawnSync(['bun', scriptPath, join(fixturesPath, 'bad')], {
      cwd: repositoryRoot,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toStartWith('FAIL check-dependencies');
  });
});
