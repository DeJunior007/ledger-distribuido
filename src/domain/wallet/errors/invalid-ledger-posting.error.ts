import { DomainError } from '../../shared/domain-error';

export class InvalidLedgerPostingError extends DomainError {
  readonly failureCode = undefined;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidLedgerPostingError';
  }
}
