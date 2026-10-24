import { describe, it, spyOn } from 'bun:test';
import { repository } from '@test/support/app';

describe('debits', () => {
  it('serializes debits', () => {
    spyOn(repository, 'save');
  });
});
