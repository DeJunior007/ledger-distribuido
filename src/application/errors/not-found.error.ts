import { FailureCode } from '@domain/shared/failure-code';
import { ApplicationError } from './application-error';

export class NotFoundError extends ApplicationError {
  readonly failureCode = FailureCode.NotFound;

  constructor(message = 'resource not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}
