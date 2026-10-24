import { DomainError } from '../../shared/domain-error';
import { FailureCode } from '../../shared/failure-code';

export class InvalidPayloadError extends DomainError {
  readonly failureCode = FailureCode.InvalidPayload;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidPayloadError';
  }
}
