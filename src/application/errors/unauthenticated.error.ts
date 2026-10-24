import { FailureCode } from '@domain/shared/failure-code';
import { ApplicationError } from './application-error';

export class UnauthenticatedError extends ApplicationError {
  readonly failureCode = FailureCode.Unauthenticated;

  constructor(message = 'unauthenticated') {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}
