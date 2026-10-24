import { FaultInjectorPort, type FaultPoint } from '@application/ports/fault-injector.port';

export class InjectedFaultError extends Error {
  constructor(readonly point: FaultPoint) {
    super(`fault injected at ${point}`);
    this.name = 'InjectedFaultError';
  }
}

export class FakeFaultInjector extends FaultInjectorPort {
  private readonly armed = new Set<FaultPoint>();
  private readonly reached: FaultPoint[] = [];

  get hits(): readonly FaultPoint[] {
    return [...this.reached];
  }

  arm(point: FaultPoint): void {
    this.armed.add(point);
  }

  hit(point: FaultPoint): void {
    this.reached.push(point);
    if (this.armed.delete(point)) {
      throw new InjectedFaultError(point);
    }
  }
}
