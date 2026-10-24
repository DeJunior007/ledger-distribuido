import { DomainError } from '../../shared/domain-error';
import { FailureCode } from '../../shared/failure-code';

export class InsufficientFundsError extends DomainError {
  readonly failureCode = FailureCode.InsufficientFunds;

  constructor(message: string) {
    super(message);
    this.name = 'InsufficientFundsError';
  }
}
