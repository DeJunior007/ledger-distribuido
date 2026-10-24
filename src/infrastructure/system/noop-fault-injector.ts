import { FaultInjectorPort } from '@application/ports/fault-injector.port';

export class NoopFaultInjector extends FaultInjectorPort {
  hit(): void {
    return;
  }
}
