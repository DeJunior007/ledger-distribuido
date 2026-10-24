import { TracerPort } from '@application/ports/tracer.port';

export class NoopTracer extends TracerPort {
  inSpan<T>(
    _name: string,
    _attributes: Readonly<Record<string, string>>,
    fn: () => Promise<T>,
  ): Promise<T> {
    return fn();
  }
}
