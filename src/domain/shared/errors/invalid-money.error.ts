import { DomainError } from '../domain-error';
import { FailureCode } from '../failure-code';

export class InvalidMoneyError extends DomainError {
  readonly failureCode = FailureCode.InvalidMoney;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}
