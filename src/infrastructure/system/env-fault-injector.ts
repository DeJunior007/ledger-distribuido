import { FaultInjectorPort, type FaultPoint } from '@application/ports/fault-injector.port';

export class EnvFaultInjector extends FaultInjectorPort {
  private readonly activePoints: ReadonlySet<string>;

  constructor(env: Readonly<Record<string, string | undefined>> = process.env) {
    super();
    this.activePoints =
      env.ENABLE_FAULT_INJECTION === 'true'
        ? new Set(
            (env.FAULT_POINTS ?? '')
              .split(',')
              .map((point) => point.trim())
              .filter((point) => point.length > 0),
          )
        : new Set();
  }

  hit(point: FaultPoint): void {
    if (this.activePoints.has(point)) {
      process.kill(process.pid, 'SIGKILL');
    }
  }
}
