import { describe, expect, it } from 'bun:test';
import { NoopFaultInjector } from '@infrastructure/system/noop-fault-injector';

describe('NoopFaultInjector', () => {
  it('does nothing at any point', () => {
    const injector = new NoopFaultInjector();
    expect(() => {
      injector.hit();
    }).not.toThrow();
  });
});
