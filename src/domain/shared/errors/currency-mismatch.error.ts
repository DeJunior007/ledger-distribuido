import { DomainError } from '../domain-error';
import { FailureCode } from '../failure-code';

export class CurrencyMismatchError extends DomainError {
  readonly failureCode = FailureCode.CurrencyMismatch;

  constructor(message: string) {
    super(message);
    this.name = 'CurrencyMismatchError';
  }
}
