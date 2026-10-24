import { ClockPort } from '@application/ports/clock.port';

export class FixedClock extends ClockPort {
  private current: Date;

  constructor(initial: Date) {
    super();
    this.current = initial;
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(value: Date): void {
    this.current = value;
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
