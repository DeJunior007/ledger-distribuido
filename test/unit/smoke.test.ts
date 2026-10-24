import { describe, expect, it } from 'bun:test';
import { APP_NAME } from '@bootstrap/app-name';
import { ALIAS_PROBE } from '@test/support/alias-probe';

describe('repository bootstrap', () => {
  it('resolves path aliases in tests', () => {
    expect(APP_NAME).toBe('jungle-wagering');
    expect(ALIAS_PROBE).toBe('alias-probe');
  });
});
