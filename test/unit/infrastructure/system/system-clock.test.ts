import { describe, expect, it } from 'bun:test';
import { SystemClock } from '@infrastructure/system/system-clock';

describe('SystemClock', () => {
  it('returns the current time', () => {
    const before = Date.now();
    const value = new SystemClock().now().getTime();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(Date.now());
  });
});
