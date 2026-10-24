import { describe, it } from 'bun:test';

describe('smoke', () => {
  it('runs against the compose stack', async () => {
    const fakes = await import('@test/support/fakes/fixed-clock');
    void fakes;
  });
});
