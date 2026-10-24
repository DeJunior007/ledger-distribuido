import { ClockPort } from '@application/ports/clock.port';

export class SystemClock extends ClockPort {
  now(): Date {
    return new Date();
  }
}
