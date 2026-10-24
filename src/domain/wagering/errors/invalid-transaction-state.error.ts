import { DomainError } from '../../shared/domain-error';

export class InvalidTransactionStateError extends DomainError {
  readonly failureCode: undefined = undefined;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransactionStateError';
  }
}
