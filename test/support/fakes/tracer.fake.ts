import { TracerPort } from '@application/ports/tracer.port';

export interface RecordedSpan {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
}

export class FakeTracer extends TracerPort {
  private readonly recorded: RecordedSpan[] = [];

  get spans(): readonly RecordedSpan[] {
    return [...this.recorded];
  }

  inSpan<T>(
    name: string,
    attributes: Readonly<Record<string, string>>,
    fn: () => Promise<T>,
  ): Promise<T> {
    this.recorded.push({ name, attributes: { ...attributes } });
    return fn();
  }
}
