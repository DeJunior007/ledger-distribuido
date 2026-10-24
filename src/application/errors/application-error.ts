import type { FailureCode } from '@domain/shared/failure-code';

export abstract class ApplicationError extends Error {
  abstract readonly failureCode: FailureCode;
}
