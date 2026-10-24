import type { LoggerPort } from '@application/ports/logger.port';
import type { MetricsPort } from '@application/ports/metrics.port';

export type BreakerComponent = 'consumer' | 'outbox' | 'scheduler' | 'events-audit';

export type BreakerProbe = 'database' | 'queue';

export type BreakerProbes = Readonly<Record<BreakerProbe, () => Promise<void>>>;

export type BreakerSleep = (ms: number) => Promise<void>;

export const BREAKER_INITIAL_WAIT_MS = 1_000;
export const BREAKER_MAX_WAIT_MS = 30_000;
export const BREAKER_PROBE_TIMEOUT_MS = 1_000;

interface OpenState {
  readonly closed: Promise<void>;
  readonly markClosed: () => void;
}

const bunSleep: BreakerSleep = (ms) => Bun.sleep(ms);

const nextWait = (currentMs: number): number => Math.min(currentMs * 2, BREAKER_MAX_WAIT_MS);

export class CircuitBreaker {
  private state: OpenState | undefined;

  constructor(
    private readonly component: BreakerComponent,
    private readonly probes: BreakerProbes,
    private readonly metrics: MetricsPort,
    private readonly logger: LoggerPort,
    private readonly sleep: BreakerSleep = bunSleep,
  ) {}

  isOpen(): boolean {
    return this.state !== undefined;
  }

  open(probe: BreakerProbe): void {
    if (this.state !== undefined) {
      return;
    }
    const closed: PromiseWithResolvers<void> = Promise.withResolvers();
    this.state = { closed: closed.promise, markClosed: closed.resolve };
    this.metrics.setCircuitBreaker(this.component, true);
    this.logger.warn('circuit breaker opened', { component: this.component, reason: probe });
    void this.probeUntilClosed(probe);
  }

  async waitUntilClosed(signal: AbortSignal): Promise<void> {
    const state = this.state;
    if (state === undefined || signal.aborted) {
      return;
    }
    const aborted: PromiseWithResolvers<void> = Promise.withResolvers();
    const onAbort = (): void => {
      aborted.resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await Promise.race([state.closed, aborted.promise]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private async probeUntilClosed(probe: BreakerProbe): Promise<void> {
    let waitMs = BREAKER_INITIAL_WAIT_MS;
    for (let attempt = 1; ; attempt += 1) {
      await this.sleep(waitMs);
      if (await this.probePasses(probe)) {
        this.close(probe);
        return;
      }
      this.logger.warn('circuit breaker probe failed', {
        component: this.component,
        reason: probe,
        attempt,
      });
      waitMs = nextWait(waitMs);
    }
  }

  private async probePasses(probe: BreakerProbe): Promise<boolean> {
    try {
      const outcome = await Promise.race([
        Promise.resolve()
          .then(() => this.probes[probe]())
          .then(() => 'passed' as const),
        this.sleep(BREAKER_PROBE_TIMEOUT_MS).then(() => 'timed_out' as const),
      ]);
      return outcome === 'passed';
    } catch {
      return false;
    }
  }

  private close(probe: BreakerProbe): void {
    const state = this.state;
    this.state = undefined;
    this.metrics.setCircuitBreaker(this.component, false);
    this.logger.info('circuit breaker closed', { component: this.component, reason: probe });
    state?.markClosed();
  }
}
