import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import jungle from './eslint-rules/index.js';

const sqsEventPublisherRestriction = {
  regex: '(?:^|/)sqs-event-publisher(?:\\.[jt]s)?$',
  message:
    'Only src/interfaces/workers/outbox-publisher.worker.ts and src/bootstrap/outbox.module.ts may import the SQS event publisher.',
};

const domainMessage = 'src/domain imports nothing outside src/domain and no external package.';

const domainRestrictions = (depth) => [
  { regex: '^(?!@domain/|\\.{1,2}/)', message: domainMessage },
  { regex: `^(?:\\./)?(?:\\.\\./){${String(depth + 1)},}`, message: domainMessage },
];

const applicationMessage =
  'src/application depends only on src/domain and its own ports, never on frameworks or outer layers.';

const applicationRestrictions = [
  {
    regex: '^(?:@|(?:\\.\\./)+(?:src/)?)(?:infrastructure|interfaces|bootstrap)(?:/|$)',
    message: applicationMessage,
  },
  { regex: '^(?:@mikro-orm|@aws-sdk|@nestjs|@opentelemetry)/', message: applicationMessage },
  { regex: '^(?:zod|pino|nestjs-pino|prom-client|jose)(?:/|$)', message: applicationMessage },
];

const infrastructureRestrictions = [
  {
    regex: '^(?:@|(?:\\.\\./)+(?:src/)?)(?:interfaces|bootstrap)(?:/|$)',
    message: 'src/infrastructure never imports src/interfaces or src/bootstrap.',
  },
];

const restrictImports = (patterns) => ({
  'no-restricted-imports': ['error', { patterns: [...patterns, sqsEventPublisherRestriction] }],
});

const domainDepths = [0, 1, 2, 3, 4, 5];

export const restrictedImportBlocks = defineConfig(
  {
    files: ['src/**/*.ts'],
    ignores: [
      'src/interfaces/workers/outbox-publisher.worker.ts',
      'src/bootstrap/outbox.module.ts',
    ],
    rules: restrictImports([]),
  },
  ...domainDepths.map((depth) => ({
    files: [`src/domain/${'*/'.repeat(depth)}*.ts`],
    rules: restrictImports(domainRestrictions(depth)),
  })),
  {
    files: ['src/application/**/*.ts'],
    rules: restrictImports(applicationRestrictions),
  },
  {
    files: ['src/infrastructure/**/*.ts'],
    rules: restrictImports(infrastructureRestrictions),
  },
);

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'spikes/**',
      'docs/**',
      'coverage/**',
      'test/unit/compliance/fixtures/**',
    ],
  },
  {
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: 'error',
    },
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      'no-console': 'error',
    },
  },
  {
    files: ['scripts/**'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/*.js'],
    rules: { '@typescript-eslint/explicit-module-boundary-types': 'off' },
  },
  {
    plugins: { jungle },
    rules: {
      'jungle/no-comments': 'error',
    },
  },
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts'],
    rules: { 'jungle/money-no-number': 'error' },
  },
  {
    files: ['src/application/**/*.ts', 'src/infrastructure/**/*.ts'],
    rules: {
      'jungle/no-module-state': [
        'error',
        {
          allow: [
            'src/infrastructure/system/env-fault-injector.ts',
            'src/infrastructure/observability/metrics.registry.ts',
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.controller.ts'],
    rules: { 'jungle/controller-access': 'error' },
  },
  ...restrictedImportBlocks,
  prettier,
);
