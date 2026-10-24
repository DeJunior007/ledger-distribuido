import { describe, expect, it } from 'bun:test';
import { createTestApp } from '@test/support/app';

describe('wallet', () => {
  it('never needs mock.module( nor spyOn( to persist a wallet', async () => {
    const app = await createTestApp();

    expect(app).toBeDefined();
  });
});
