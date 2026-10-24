import { DomainError } from '../../shared/domain-error';

export class InvalidOutboxTransitionError extends DomainError {
  readonly failureCode: undefined = undefined;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidOutboxTransitionError';
  }
}
