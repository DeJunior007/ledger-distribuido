import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DynamicModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { Level, Logger } from 'pino';

export interface HttpLogIds {
  readonly requestId: string | undefined;
  readonly correlationId: string | undefined;
}

export interface HttpLoggerModuleOptions {
  readonly logger: Logger;
  readonly idsOf: (response: ServerResponse) => HttpLogIds;
}

export interface AccessLogFields {
  readonly method: string | undefined;
  readonly route: string;
  readonly statusCode: number;
  readonly responseTime: number | undefined;
  readonly requestId: string | undefined;
  readonly correlationId: string | undefined;
}

const omitted = (): undefined => undefined;

const originalUrlOf = (request: IncomingMessage): string => {
  const original: unknown = Reflect.get(request, 'originalUrl');
  return typeof original === 'string' ? original : (request.url ?? '');
};

export const routeWithoutQuery = (request: IncomingMessage): string => {
  const [path = ''] = originalUrlOf(request).split('?');
  return path;
};

const responseTimeOf = (value: unknown): number | undefined => {
  if (typeof value !== 'object' || value === null || !('responseTime' in value)) {
    return undefined;
  }
  return typeof value.responseTime === 'number' ? value.responseTime : undefined;
};

export const accessLogLevel = (
  _request: IncomingMessage,
  response: ServerResponse,
  error?: Error,
): Level => {
  if (error !== undefined || response.statusCode >= 500) {
    return 'error';
  }
  return response.statusCode >= 400 ? 'warn' : 'info';
};

export const createHttpLoggerModule = (options: HttpLoggerModuleOptions): DynamicModule => {
  const accessLogFields = (
    request: IncomingMessage,
    response: ServerResponse,
    value: unknown,
  ): AccessLogFields => {
    const ids = options.idsOf(response);
    return {
      method: request.method,
      route: routeWithoutQuery(request),
      statusCode: response.statusCode,
      responseTime: responseTimeOf(value),
      requestId: ids.requestId,
      correlationId: ids.correlationId,
    };
  };
  return LoggerModule.forRoot({
    pinoHttp: {
      logger: options.logger,
      wrapSerializers: false,
      serializers: { req: omitted, res: omitted },
      customLogLevel: accessLogLevel,
      customSuccessObject: accessLogFields,
      customErrorObject: (request, response, _error, value: unknown) =>
        accessLogFields(request, response, value),
    },
  });
};
