import { DomainError } from '../../shared/domain-error';

export class InvalidIdempotencyTransitionError extends DomainError {
  readonly failureCode: undefined = undefined;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidIdempotencyTransitionError';
  }
}
