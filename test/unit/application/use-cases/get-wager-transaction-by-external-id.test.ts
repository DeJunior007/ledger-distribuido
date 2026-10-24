import { describe, expect, it } from 'bun:test';
import { NotFoundError } from '@application/errors/not-found.error';
import { GetWagerTransactionByExternalIdUseCase } from '@application/use-cases/get-wager-transaction-by-external-id.use-case';
import {
  newUnitOfWork,
  operatorIdentity,
  providerIdentity,
  seedTransaction,
  rejection,
} from './fixtures';

describe('GetWagerTransactionByExternalIdUseCase', () => {
  it('returns the view to the owning provider', async () => {
    const uow = newUnitOfWork();
    seedTransaction(uow);

    const view = await new GetWagerTransactionByExternalIdUseCase(uow).execute({
      providerId: 'provider-1',
      externalTransactionId: 'ext-1',
      identity: providerIdentity('provider-1'),
    });

    expect(view.id).toBe('tx-1');
  });

  it('returns the view to an operator', async () => {
    const uow = newUnitOfWork();
    seedTransaction(uow);

    const view = await new GetWagerTransactionByExternalIdUseCase(uow).execute({
      providerId: 'provider-1',
      externalTransactionId: 'ext-1',
      identity: operatorIdentity,
    });

    expect(view.externalTransactionId).toBe('ext-1');
  });

  it('fails with not found when a provider asks for another provider', async () => {
    const uow = newUnitOfWork();
    seedTransaction(uow);

    expect(
      await rejection(
        new GetWagerTransactionByExternalIdUseCase(uow).execute({
          providerId: 'provider-1',
          externalTransactionId: 'ext-1',
          identity: providerIdentity('provider-2'),
        }),
      ),
    ).toBeInstanceOf(NotFoundError);
  });

  it('fails with not found when the external id is unknown', async () => {
    const uow = newUnitOfWork();
    seedTransaction(uow);

    expect(
      await rejection(
        new GetWagerTransactionByExternalIdUseCase(uow).execute({
          providerId: 'provider-1',
          externalTransactionId: 'unknown',
          identity: operatorIdentity,
        }),
      ),
    ).toBeInstanceOf(NotFoundError);
  });
});
