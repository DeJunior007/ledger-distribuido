import { afterEach, describe, expect, it } from 'bun:test';
import { SpanStatusCode, context, propagation, trace } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { startTracing } from '@infrastructure/observability/otel';
import type { Tracing } from '@infrastructure/observability/otel';
import { NoopTracer } from '@infrastructure/system/noop-tracer';

const started: Tracing[] = [];

const enabledTracing = (exporter: InMemorySpanExporter): Tracing => {
  const tracing = startTracing({
    enabled: true,
    endpoint: undefined,
    serviceName: 'api',
    exporter,
  });
  started.push(tracing);
  return tracing;
};

const spanNamed = (spans: readonly ReadableSpan[], name: string): ReadableSpan | undefined =>
  spans.find((span) => span.name === name);

const injectedHeaders = (): Record<string, string> => {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
};

afterEach(async () => {
  await Promise.all(started.splice(0).map((tracing) => tracing.shutdown()));
});

describe('startTracing', () => {
  it('returns a no-op tracer and registers nothing when disabled', async () => {
    const tracing = startTracing({ enabled: false, endpoint: undefined, serviceName: 'api' });
    started.push(tracing);
    const result = await tracing.tracer.inSpan('usecase.noop', { walletId: 'w-1' }, () =>
      Promise.resolve({
        headers: injectedHeaders(),
        recording: trace.getActiveSpan()?.isRecording() ?? false,
      }),
    );
    expect(tracing.enabled).toBe(false);
    expect(tracing.tracer).toBeInstanceOf(NoopTracer);
    expect(result).toEqual({ headers: {}, recording: false });
    expect(trace.getTracer('probe').startSpan('probe').isRecording()).toBe(false);
  });

  it('exports spans with the service name and the given attributes', async () => {
    const exporter = new InMemorySpanExporter();
    const tracing = enabledTracing(exporter);
    const value = await tracing.tracer.inSpan('http.request', { requestId: 'req-1' }, () =>
      Promise.resolve(42),
    );
    await tracing.flush();
    const span = spanNamed(exporter.getFinishedSpans(), 'http.request');
    expect(value).toBe(42);
    expect(tracing.enabled).toBe(true);
    expect(span?.attributes).toEqual({ requestId: 'req-1' });
    expect(span?.resource.attributes['service.name']).toBe('api');
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('nests spans across awaits through the context manager', async () => {
    const exporter = new InMemorySpanExporter();
    const tracing = enabledTracing(exporter);
    await tracing.tracer.inSpan('sqs.process', { messageId: 'm-1' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await tracing.tracer.inSpan('usecase.submit', {}, async () => {
        await Promise.resolve();
        await tracing.tracer.inSpan('db.transaction', {}, () => Promise.resolve());
      });
    });
    await tracing.flush();
    const spans = exporter.getFinishedSpans();
    const root = spanNamed(spans, 'sqs.process');
    const useCase = spanNamed(spans, 'usecase.submit');
    const transaction = spanNamed(spans, 'db.transaction');
    expect(root?.parentSpanContext).toBeUndefined();
    expect(useCase?.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
    expect(transaction?.parentSpanContext?.spanId).toBe(useCase?.spanContext().spanId);
    expect(transaction?.spanContext().traceId).toBe(root?.spanContext().traceId);
  });

  it('keeps concurrent spans in separate traces', async () => {
    const exporter = new InMemorySpanExporter();
    const tracing = enabledTracing(exporter);
    const child = (parent: string): Promise<void> =>
      tracing.tracer.inSpan(parent, {}, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await tracing.tracer.inSpan(`${parent}.child`, {}, () => Promise.resolve());
      });
    await Promise.all([child('first'), child('second')]);
    await tracing.flush();
    const spans = exporter.getFinishedSpans();
    const first = spanNamed(spans, 'first');
    const second = spanNamed(spans, 'second');
    expect(spanNamed(spans, 'first.child')?.parentSpanContext?.spanId).toBe(
      first?.spanContext().spanId,
    );
    expect(spanNamed(spans, 'second.child')?.parentSpanContext?.spanId).toBe(
      second?.spanContext().spanId,
    );
    expect(first?.spanContext().traceId).not.toBe(second?.spanContext().traceId);
  });

  it('registers the W3C propagator for the active span', async () => {
    const exporter = new InMemorySpanExporter();
    const tracing = enabledTracing(exporter);
    const headers = await tracing.tracer.inSpan('outbox.publish', {}, () =>
      Promise.resolve(injectedHeaders()),
    );
    await tracing.flush();
    const span = spanNamed(exporter.getFinishedSpans(), 'outbox.publish');
    const traceId = span?.spanContext().traceId ?? 'missing';
    const spanId = span?.spanContext().spanId ?? 'missing';
    expect(headers).toEqual({ traceparent: `00-${traceId}-${spanId}-01` });
  });

  it('continues a trace extracted from a traceparent', async () => {
    const exporter = new InMemorySpanExporter();
    const tracing = enabledTracing(exporter);
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const parentSpanId = '00f067aa0ba902b7';
    const remote = propagation.extract(context.active(), {
      traceparent: `00-${traceId}-${parentSpanId}-01`,
    });
    await context.with(remote, () =>
      tracing.tracer.inSpan('sqs.process', {}, () => Promise.resolve()),
    );
    await tracing.flush();
    const span = spanNamed(exporter.getFinishedSpans(), 'sqs.process');
    expect(span?.spanContext().traceId).toBe(traceId);
    expect(span?.parentSpanContext?.spanId).toBe(parentSpanId);
  });

  it('marks the span as failed and rethrows the error', async () => {
    const exporter = new InMemorySpanExporter();
    const tracing = enabledTracing(exporter);
    const boom = new RangeError('boom');
    const failure = await tracing.tracer
      .inSpan('usecase.fail', {}, () => Promise.reject(boom))
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );
    await tracing.flush();
    const span = spanNamed(exporter.getFinishedSpans(), 'usecase.fail');
    expect(failure).toBe(boom);
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes).toEqual({ 'error.type': 'RangeError' });
  });

  it('unregisters the globals on shutdown', async () => {
    const tracing = startTracing({
      enabled: true,
      endpoint: undefined,
      serviceName: 'api',
      exporter: new InMemorySpanExporter(),
    });
    await tracing.shutdown();
    const headers = await new NoopTracer().inSpan('after', {}, () =>
      Promise.resolve(injectedHeaders()),
    );
    expect(headers).toEqual({});
    expect(trace.getTracer('probe').startSpan('probe').isRecording()).toBe(false);
  });
});
