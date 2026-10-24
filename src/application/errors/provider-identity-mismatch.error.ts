import { FailureCode } from '@domain/shared/failure-code';
import { ApplicationError } from './application-error';

export class ProviderIdentityMismatchError extends ApplicationError {
  readonly failureCode = FailureCode.ProviderIdentityMismatch;

  constructor(message = 'provider identity mismatch') {
    super(message);
    this.name = 'ProviderIdentityMismatchError';
  }
}
