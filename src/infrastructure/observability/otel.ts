import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import type { TracerPort } from '@application/ports/tracer.port';
import type { AppConfig } from '@infrastructure/config/env.schema';
import { NoopTracer } from '@infrastructure/system/noop-tracer';
import { OtelTracerAdapter } from './otel-tracer.adapter';

export interface TracingSettings {
  readonly enabled: AppConfig['OTEL_ENABLED'];
  readonly endpoint: AppConfig['OTEL_EXPORTER_OTLP_ENDPOINT'];
  readonly serviceName: string;
  readonly exporter?: SpanExporter;
}

export interface Tracing {
  readonly enabled: boolean;
  readonly tracer: TracerPort;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

const resolved = (): Promise<void> => Promise.resolve();

const disabledTracing = (): Tracing => ({
  enabled: false,
  tracer: new NoopTracer(),
  flush: resolved,
  shutdown: resolved,
});

const otlpExporter = (endpoint: string | undefined): SpanExporter =>
  new OTLPTraceExporter(endpoint === undefined ? {} : { url: `${endpoint}/v1/traces` });

export function startTracing(settings: TracingSettings): Tracing {
  if (!settings.enabled) {
    return disabledTracing();
  }
  const exporter = settings.exporter ?? otlpExporter(settings.endpoint);
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: settings.serviceName }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  const contextManager = new AsyncLocalStorageContextManager().enable();
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  return {
    enabled: true,
    tracer: new OtelTracerAdapter(provider.getTracer(settings.serviceName)),
    flush: () => provider.forceFlush(),
    shutdown: async () => {
      await provider.shutdown();
      trace.disable();
      context.disable();
      propagation.disable();
    },
  };
}
