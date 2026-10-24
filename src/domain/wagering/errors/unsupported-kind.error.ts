import { DomainError } from '../../shared/domain-error';
import { FailureCode } from '../../shared/failure-code';

export class UnsupportedKindError extends DomainError {
  readonly failureCode = FailureCode.UnsupportedKind;

  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedKindError';
  }
}
