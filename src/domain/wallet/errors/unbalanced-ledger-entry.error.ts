import { DomainError } from '../../shared/domain-error';

export class UnbalancedLedgerEntryError extends DomainError {
  readonly failureCode = undefined;

  constructor(message: string) {
    super(message);
    this.name = 'UnbalancedLedgerEntryError';
  }
}
