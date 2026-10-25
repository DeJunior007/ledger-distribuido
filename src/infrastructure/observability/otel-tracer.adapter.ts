import { SpanStatusCode } from '@opentelemetry/api';
import type { Span, Tracer } from '@opentelemetry/api';
import { TracerPort } from '@application/ports/tracer.port';

const errorType = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

export class OtelTracerAdapter extends TracerPort {
  constructor(private readonly tracer: Tracer) {
    super();
  }

  inSpan<T>(
    name: string,
    attributes: Readonly<Record<string, string>>,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.tracer.startActiveSpan(name, { attributes: { ...attributes } }, (span: Span) =>
      this.run(span, fn),
    );
  }

  private async run<T>(span: Span, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error: unknown) {
      span.setAttribute('error.type', errorType(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  }
}
