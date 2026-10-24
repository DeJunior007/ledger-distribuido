import { DomainError } from '../domain-error';

export class PersistedMoneyCorruptedError extends DomainError {
  readonly failureCode: undefined = undefined;

  constructor(message: string) {
    super(message);
    this.name = 'PersistedMoneyCorruptedError';
  }
}
