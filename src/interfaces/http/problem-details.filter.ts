import type { Request, Response } from 'express';
import {
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { DomainError } from '@domain/shared/domain-error';
import { FAILURE_CODE_METADATA, FailureCategory, FailureCode } from '@domain/shared/failure-code';
import { ApplicationError } from '@application/errors/application-error';
import { ErrorClass, TechnicalError, classifyError } from '@application/errors/error-class';
import type { IdGeneratorPort } from '@application/ports/id-generator.port';
import type { MetricsPort } from '@application/ports/metrics.port';
import { BodyParserError } from './body-parser-error.middleware';
import { ensureCorrelation } from './correlation.middleware';
import { PROBLEM_CONTENT_TYPE, problemBodyOf, type ProblemExtras } from './http-status';
import { RequestValidationError } from './zod-validation.pipe';

export interface ProblemLogger {
  error(fields: object, message: string): void;
}

export interface ProblemDetailsFilterDependencies {
  readonly ids: IdGeneratorPort;
  readonly metrics: MetricsPort;
  readonly logger: ProblemLogger;
}

export const RETRY_AFTER_SHORT_SECONDS = 1;
export const RETRY_AFTER_LONG_SECONDS = 5;

const UNAUTHORIZED_STATUS: number = HttpStatus.UNAUTHORIZED;

interface ProblemResolution {
  readonly failureCode: FailureCode;
  readonly extras: ProblemExtras;
  readonly retryAfterSeconds: number | undefined;
  readonly logCause: boolean;
}

const resolved = (failureCode: FailureCode, extras: ProblemExtras = {}): ProblemResolution => ({
  failureCode,
  extras,
  retryAfterSeconds: undefined,
  logCause: false,
});

const unavailable = (retryAfterSeconds: number): ProblemResolution => ({
  failureCode: FailureCode.InfrastructureUnavailable,
  extras: {},
  retryAfterSeconds,
  logCause: false,
});

const internalError: ProblemResolution = {
  failureCode: FailureCode.InternalError,
  extras: {},
  retryAfterSeconds: RETRY_AFTER_LONG_SECONDS,
  logCause: true,
};

const stringProperty = (source: object, key: 'transactionId' | 'walletId'): string | undefined => {
  const value: unknown = Reflect.get(source, key);
  return typeof value === 'string' ? value : undefined;
};

const extrasOf = (error: Error): ProblemExtras => ({
  transactionId: stringProperty(error, 'transactionId'),
  walletId: stringProperty(error, 'walletId'),
});

const isValidationCode = (failureCode: FailureCode | undefined): failureCode is FailureCode =>
  failureCode !== undefined &&
  FAILURE_CODE_METADATA[failureCode].category === FailureCategory.Validation;

const resolveTechnical = (error: TechnicalError): ProblemResolution => {
  switch (error.errorClass) {
    case ErrorClass.Transient:
    case ErrorClass.Race:
      return unavailable(RETRY_AFTER_SHORT_SECONDS);
    case ErrorClass.Connectivity:
      return unavailable(RETRY_AFTER_LONG_SECONDS);
    case ErrorClass.Permanent:
    case ErrorClass.Deterministic:
      return internalError;
  }
};

export const resolveProblem = (exception: unknown): ProblemResolution => {
  if (exception instanceof RequestValidationError) {
    return resolved(exception.failureCode, { errors: exception.errors });
  }
  if (exception instanceof BodyParserError) {
    return resolved(FailureCode.InvalidPayload);
  }
  if (exception instanceof HttpException && exception.getStatus() === 404) {
    return resolved(FailureCode.NotFound);
  }
  if (exception instanceof DomainError && isValidationCode(exception.failureCode)) {
    return resolved(exception.failureCode, extrasOf(exception));
  }
  if (exception instanceof ApplicationError) {
    return resolved(exception.failureCode, extrasOf(exception));
  }
  if (exception instanceof TechnicalError) {
    return resolveTechnical(exception);
  }
  return internalError;
};

export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(private readonly deps: ProblemDetailsFilterDependencies) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const correlation = ensureCorrelation(request, response, this.deps.ids);
    const resolution = resolveProblem(exception);
    this.recordLockConflict(exception);
    if (resolution.logCause) {
      this.deps.logger.error(
        {
          err: exception,
          failureCode: resolution.failureCode,
          errorClass: classifyError(exception),
          requestId: correlation.requestId,
          correlationId: correlation.correlationId,
        },
        'request failed',
      );
    }
    if (response.headersSent) {
      response.end();
      return;
    }
    const body = problemBodyOf(resolution.failureCode, resolution.extras);
    if (resolution.retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(resolution.retryAfterSeconds));
    }
    if (body.status === UNAUTHORIZED_STATUS) {
      response.setHeader('WWW-Authenticate', 'Bearer');
    }
    response.status(body.status).type(PROBLEM_CONTENT_TYPE).json(body);
  }

  private recordLockConflict(exception: unknown): void {
    if (!(exception instanceof TechnicalError)) {
      return;
    }
    if (exception.reason === 'lock_timeout') {
      this.deps.metrics.lockConflict('lock_timeout');
    }
    if (exception.reason === 'version_mismatch') {
      this.deps.metrics.lockConflict('version_mismatch');
    }
  }
}
