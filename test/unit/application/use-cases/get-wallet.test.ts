import { describe, expect, it } from 'bun:test';
import { NotFoundError } from '@application/errors/not-found.error';
import { GetWalletUseCase } from '@application/use-cases/get-wallet.use-case';
import {
  newUnitOfWork,
  operatorIdentity,
  providerIdentity,
  seedWallet,
  rejection,
} from './fixtures';

describe('GetWalletUseCase', () => {
  it('returns only the balance view to a provider', async () => {
    const uow = newUnitOfWork();
    seedWallet(uow);

    const view = await new GetWalletUseCase(uow).execute({
      walletId: 'wallet-1',
      identity: providerIdentity('provider-1'),
    });

    expect(view).toStrictEqual({
      id: 'wallet-1',
      balance: { amount: '50.00', currency: 'BRL' },
      version: 3,
    });
  });

  it('returns the full wallet view to an operator', async () => {
    const uow = newUnitOfWork();
    seedWallet(uow);

    const view = await new GetWalletUseCase(uow).execute({
      walletId: 'wallet-1',
      identity: operatorIdentity,
    });

    expect(view).toStrictEqual({
      id: 'wallet-1',
      playerId: 'player-1',
      balance: { amount: '50.00', currency: 'BRL' },
      version: 3,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('fails with not found when the wallet does not exist', async () => {
    const uow = newUnitOfWork();

    expect(
      await rejection(
        new GetWalletUseCase(uow).execute({ walletId: 'missing', identity: operatorIdentity }),
      ),
    ).toBeInstanceOf(NotFoundError);
  });
});
