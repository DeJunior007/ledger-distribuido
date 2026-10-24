import { describe, it, mock } from 'bun:test';

mock.module('pg', () => ({}));

describe('wallet', () => {
  it('persists a wallet', () => {});
});
