import { describe, it } from 'bun:test';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import noModuleState from '../../../eslint-rules/no-module-state.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it;

const ruleTester = new RuleTester({ languageOptions: { parser: tseslint.parser } });

const allow = [
  'src/infrastructure/system/env-fault-injector.ts',
  'src/infrastructure/observability/metrics.registry.ts',
];

const options = [{ allow }];

const applicationFile = 'src/application/services/sample.ts';
const infrastructureFile = 'src/infrastructure/persistence/sample.ts';

const statefulCode =
  'let counter = 0;\nexport const cache = new Map<string, number>();\nexport class Holder {\n  private readonly seen = new Set<string>();\n}\n';

ruleTester.run('jungle/no-module-state', noModuleState, {
  valid: [
    { code: 'export const limit = 10;\n', filename: applicationFile, options },
    {
      code: 'export function collect(): Map<string, number> {\n  let total = 0;\n  total += 1;\n  return new Map([["total", total]]);\n}\n',
      filename: applicationFile,
      options,
    },
    {
      code: 'export class Collector {\n  collect(): Set<string> {\n    return new Set();\n  }\n  readonly build = () => new WeakMap<object, string>();\n}\n',
      filename: infrastructureFile,
      options,
    },
    { code: statefulCode, filename: allow[0], options },
    { code: statefulCode, filename: allow[1], options },
  ],
  invalid: [
    {
      code: 'let counter = 0;\nexport function next(): number {\n  counter += 1;\n  return counter;\n}\n',
      filename: applicationFile,
      options,
      errors: [{ messageId: 'moduleLet', data: { kind: 'let' } }],
    },
    {
      code: 'export let current = 0;\n',
      filename: infrastructureFile,
      options,
      errors: [{ messageId: 'moduleLet', data: { kind: 'let' } }],
    },
    {
      code: 'export const cache = new Map<string, number>();\nconst seen = new Set<string>();\nexport const owners = { byKey: new WeakMap<object, string>() };\n',
      filename: infrastructureFile,
      options,
      errors: [
        { messageId: 'moduleCollection', data: { name: 'Map' } },
        { messageId: 'moduleCollection', data: { name: 'Set' } },
        { messageId: 'moduleCollection', data: { name: 'WeakMap' } },
      ],
    },
    {
      code: 'export class Repository {\n  private readonly rows = new Map<string, number>();\n  static readonly seen = new Set<string>();\n  private readonly owners = new WeakMap<object, string>();\n}\n',
      filename: applicationFile,
      options,
      errors: [
        { messageId: 'classField', data: { name: 'Map' } },
        { messageId: 'classField', data: { name: 'Set' } },
        { messageId: 'classField', data: { name: 'WeakMap' } },
      ],
    },
    {
      code: statefulCode,
      filename: 'src/infrastructure/system/system-clock.ts',
      options,
      errors: [
        { messageId: 'moduleLet', data: { kind: 'let' } },
        { messageId: 'moduleCollection', data: { name: 'Map' } },
        { messageId: 'classField', data: { name: 'Set' } },
      ],
    },
    {
      code: statefulCode,
      filename: allow[0],
      errors: [
        { messageId: 'moduleLet', data: { kind: 'let' } },
        { messageId: 'moduleCollection', data: { name: 'Map' } },
        { messageId: 'classField', data: { name: 'Set' } },
      ],
    },
  ],
});
