import type { IncomingMessage, ServerResponse } from 'node:http';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import { IdGeneratorPort } from '@application/ports/id-generator.port';
import { requestContext } from '@infrastructure/observability/request-context';

export const REQUEST_ID_HEADER = 'X-Request-Id';
export const CORRELATION_ID_HEADER = 'X-Correlation-Id';
export const API_COMPONENT = 'api';

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

@Injectable()
export class CorrelationMiddleware implements NestMiddleware<IncomingMessage, ServerResponse> {
  constructor(private readonly ids: IdGeneratorPort) {}

  use(request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void): void {
    const { requestId, correlationId } = ensureCorrelation(request, response, this.ids);
    void requestContext.run({ requestId, correlationId, component: API_COMPONENT }, () => {
      next();
      return Promise.resolve();
    });
  }
}
