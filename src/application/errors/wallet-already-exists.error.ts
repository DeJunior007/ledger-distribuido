import { FailureCode } from '@domain/shared/failure-code';
import { ApplicationError } from './application-error';

export class WalletAlreadyExistsError extends ApplicationError {
  readonly failureCode = FailureCode.WalletAlreadyExists;

  constructor(readonly walletId: string) {
    super('wallet already exists');
    this.name = 'WalletAlreadyExistsError';
  }
}
