import { describe, expect, it } from 'bun:test';
import { ApplicationError } from '@application/errors/application-error';
import { ForbiddenError } from '@application/errors/forbidden.error';
import { NotFoundError } from '@application/errors/not-found.error';
import { ProviderIdentityMismatchError } from '@application/errors/provider-identity-mismatch.error';
import { UnauthenticatedError } from '@application/errors/unauthenticated.error';
import { WalletAlreadyExistsError } from '@application/errors/wallet-already-exists.error';
import { FailureCode } from '@domain/shared/failure-code';

describe('application errors', () => {
  it('carries the failure code of each error', () => {
    expect(new NotFoundError().failureCode).toBe(FailureCode.NotFound);
    expect(new WalletAlreadyExistsError('w-1').failureCode).toBe(FailureCode.WalletAlreadyExists);
    expect(new UnauthenticatedError().failureCode).toBe(FailureCode.Unauthenticated);
    expect(new ForbiddenError().failureCode).toBe(FailureCode.Forbidden);
    expect(new ProviderIdentityMismatchError().failureCode).toBe(
      FailureCode.ProviderIdentityMismatch,
    );
  });

  it('keeps the wallet id on wallet already exists', () => {
    expect(new WalletAlreadyExistsError('w-1').walletId).toBe('w-1');
  });

  it('extends application error and error', () => {
    const error = new ForbiddenError();
    expect(error).toBeInstanceOf(ApplicationError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ForbiddenError');
  });
});
