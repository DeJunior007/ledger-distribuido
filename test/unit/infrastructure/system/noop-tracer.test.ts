import { describe, expect, it } from 'bun:test';
import { NoopTracer } from '@infrastructure/system/noop-tracer';

describe('NoopTracer', () => {
  it('runs the function and returns its result', async () => {
    const result = await new NoopTracer().inSpan('usecase.test', { key: 'value' }, () =>
      Promise.resolve(42),
    );
    expect(result).toBe(42);
  });
});
