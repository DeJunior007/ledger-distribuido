import { DomainError } from '../../shared/domain-error';
import { FailureCode } from '../../shared/failure-code';

export class ReferenceRequiredError extends DomainError {
  readonly failureCode = FailureCode.ReferenceRequired;

  constructor(message: string) {
    super(message);
    this.name = 'ReferenceRequiredError';
  }
}
