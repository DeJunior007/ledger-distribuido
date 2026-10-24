import { DomainError } from '../../shared/domain-error';
import { FailureCode } from '../../shared/failure-code';

export class InvalidAmountError extends DomainError {
  readonly failureCode = FailureCode.InvalidAmount;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidAmountError';
  }
}
