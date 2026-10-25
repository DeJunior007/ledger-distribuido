import type { IncomingMessage, ServerResponse } from 'node:http';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import { context, propagation } from '@opentelemetry/api';
import { IdGeneratorPort } from '@application/ports/id-generator.port';
import { TracerPort } from '@application/ports/tracer.port';
import { requestContext } from '@infrastructure/observability/request-context';

export const REQUEST_ID_HEADER = 'X-Request-Id';
export const CORRELATION_ID_HEADER = 'X-Correlation-Id';
export const API_COMPONENT = 'api';
export const HTTP_REQUEST_SPAN = 'http.request';

const CORRELATION_ID_PATTERN = /^[\x21-\x7E]{1,128}$/;

export interface CorrelationIds {
  readonly requestId: string;
  readonly correlationId: string;
}

export interface PartialCorrelationIds {
  readonly requestId: string | undefined;
  readonly correlationId: string | undefined;
}

type HeaderReader = Pick<ServerResponse, 'getHeader'>;

type HeaderWriter = Pick<ServerResponse, 'getHeader' | 'setHeader' | 'headersSent'>;

const singleHeader = (
  value: number | string | readonly string[] | undefined,
): string | undefined => (typeof value === 'string' ? value : undefined);

export const correlationIdsOf = (response: HeaderReader): PartialCorrelationIds => ({
  requestId: singleHeader(response.getHeader(REQUEST_ID_HEADER)),
  correlationId: singleHeader(response.getHeader(CORRELATION_ID_HEADER)),
});

const acceptedCorrelationId = (request: Pick<IncomingMessage, 'headers'>): string | undefined => {
  const header = singleHeader(request.headers[CORRELATION_ID_HEADER.toLowerCase()]);
  return header !== undefined && CORRELATION_ID_PATTERN.test(header) ? header : undefined;
};

export const ensureCorrelation = (
  request: Pick<IncomingMessage, 'headers'>,
  response: HeaderWriter,
  ids: IdGeneratorPort,
): CorrelationIds => {
  const existing = correlationIdsOf(response);
  if (existing.requestId !== undefined && existing.correlationId !== undefined) {
    return { requestId: existing.requestId, correlationId: existing.correlationId };
  }
  const requestId = ids.next();
  const correlationId = acceptedCorrelationId(request) ?? requestId;
  if (!response.headersSent) {
    response.setHeader(REQUEST_ID_HEADER, requestId);
    response.setHeader(CORRELATION_ID_HEADER, correlationId);
  }
  return { requestId, correlationId };
};

const responseFinished = (response: ServerResponse): Promise<void> => {
  const done: PromiseWithResolvers<void> = Promise.withResolvers();
  const settle = (): void => {
    response.off('finish', settle);
    response.off('close', settle);
    done.resolve();
  };
  response.once('finish', settle);
  response.once('close', settle);
  return done.promise;
};

@Injectable()
export class CorrelationMiddleware implements NestMiddleware<IncomingMessage, ServerResponse> {
  constructor(
    private readonly ids: IdGeneratorPort,
    private readonly tracer: TracerPort,
  ) {}

  use(request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void): void {
    const { requestId, correlationId } = ensureCorrelation(request, response, this.ids);
    const parent = propagation.extract(context.active(), request.headers);
    void requestContext.run({ requestId, correlationId, component: API_COMPONENT }, () =>
      context.with(parent, () =>
        this.tracer.inSpan(HTTP_REQUEST_SPAN, { requestId, correlationId }, () => {
          const finished = responseFinished(response);
          next();
          return finished;
        }),
      ),
    );
  }
}
