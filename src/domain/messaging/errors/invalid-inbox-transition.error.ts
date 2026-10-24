import { DomainError } from '../../shared/domain-error';

export class InvalidInboxTransitionError extends DomainError {
  readonly failureCode: undefined = undefined;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidInboxTransitionError';
  }
}
