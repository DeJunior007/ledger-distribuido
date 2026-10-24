export interface WaitForOptions {
  readonly timeoutMs: number;
  readonly intervalMs: number;
}

export class WaitForTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`condition not met within ${String(timeoutMs)} ms`);
    this.name = 'WaitForTimeoutError';
  }
}

export const waitFor = async (
  check: () => boolean | Promise<boolean>,
  options: WaitForOptions,
): Promise<void> => {
  const deadline = performance.now() + options.timeoutMs;
  for (;;) {
    if (await check()) {
      return;
    }
    if (performance.now() + options.intervalMs > deadline) {
      throw new WaitForTimeoutError(options.timeoutMs);
    }
    await Bun.sleep(options.intervalMs);
  }
};
