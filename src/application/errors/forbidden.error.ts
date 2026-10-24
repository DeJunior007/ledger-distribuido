import { FailureCode } from '@domain/shared/failure-code';
import { ApplicationError } from './application-error';

export class ForbiddenError extends ApplicationError {
  readonly failureCode = FailureCode.Forbidden;

  constructor(message = 'forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}
