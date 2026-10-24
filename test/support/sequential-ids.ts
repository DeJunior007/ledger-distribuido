import { IdGeneratorPort } from '@application/ports/id-generator.port';

export class SequentialIds extends IdGeneratorPort {
  private counter = 0;

  next(): string {
    this.counter += 1;
    return `00000000-0000-7000-8000-${this.counter.toString(16).padStart(12, '0')}`;
  }
}
