import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import jungle from './eslint-rules/index.js';

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
  prettier,
);
