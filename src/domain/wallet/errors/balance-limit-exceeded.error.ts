import { DomainError } from '../../shared/domain-error';
import { FailureCode } from '../../shared/failure-code';

export class BalanceLimitExceededError extends DomainError {
  readonly failureCode = FailureCode.BalanceLimitExceeded;

  constructor(message: string) {
    super(message);
    this.name = 'BalanceLimitExceededError';
  }
}
