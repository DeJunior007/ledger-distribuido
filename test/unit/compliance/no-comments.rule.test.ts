import { describe, it } from 'bun:test';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import noComments from '../../../eslint-rules/no-comments.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it;

const ruleTester = new RuleTester({
  languageOptions: { parser: tseslint.parser },
  linterOptions: { noInlineConfig: true },
});

const commentError = { messageId: 'comment' };

const ignoredDirective = (directive: string) => ({
  message: `'${directive}' has no effect because you have 'noInlineConfig' setting in your config.`,
});

ruleTester.run('jungle/no-comments', noComments, {
  valid: [
    { code: '#!/usr/bin/env bun\nconst answer = 42;\n' },
    { code: "const url = 'https://example.com/path';\n" },
    { code: 'const pattern = `//${String(1)}//`;\n' },
    { code: 'const marker = "/* not a comment */";\n' },
  ],
  invalid: [
    { code: 'const answer = 42; // explained\n', errors: [commentError] },
    { code: '/* block */\nconst answer = 42;\n', errors: [commentError] },
    {
      code: '/**\n * Documented.\n */\nexport function answer(): number {\n  return 42;\n}\n',
      errors: [commentError],
    },
    {
      code: '/* eslint-disable */\nconst answer = 42;\n',
      errors: [ignoredDirective('/* eslint-disable */'), commentError],
    },
    {
      code: '// eslint-disable-next-line\nconst answer = 42;\n',
      errors: [ignoredDirective('// eslint-disable-next-line'), commentError],
    },
    {
      code: "// @ts-expect-error\nconst answer: number = 'x';\n",
      errors: [commentError],
    },
    { code: '// @ts-ignore\nconst answer = 42;\n', errors: [commentError] },
    { code: '/// <reference types="bun" />\nconst answer = 42;\n', errors: [commentError] },
    {
      code: '#!/usr/bin/env bun\n// after shebang\nconst answer = 42;\n',
      errors: [commentError],
    },
  ],
});
