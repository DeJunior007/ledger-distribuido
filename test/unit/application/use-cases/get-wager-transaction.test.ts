import { describe, expect, it } from 'bun:test';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '@domain/wagering/wager-transaction-status';
import { NotFoundError } from '@application/errors/not-found.error';
import { GetWagerTransactionUseCase } from '@application/use-cases/get-wager-transaction.use-case';
import {
  newUnitOfWork,
  operatorIdentity,
  providerIdentity,
  seedTransaction,
  rejection,
} from './fixtures';

describe('GetWagerTransactionUseCase', () => {
  it('returns the view to the owning provider', async () => {
    const uow = newUnitOfWork();
    seedTransaction(uow);

    const view = await new GetWagerTransactionUseCase(uow).execute({
      transactionId: 'tx-1',
      identity: providerIdentity('provider-1'),
    });

    expect(view).toStrictEqual({
      id: 'tx-1',
      providerId: 'provider-1',
      externalTransactionId: 'ext-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
      status: WagerTransactionStatus.Processed,
      balance: { amount: '40.00', currency: 'BRL' },
      createdAt: '2026-01-01T00:00:00.000Z',
      processedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('returns the view to an operator regardless of provider', async () => {
    const uow = newUnitOfWork();
    seedTransaction(uow);

    const view = await new GetWagerTransactionUseCase(uow).execute({
      transactionId: 'tx-1',
      identity: operatorIdentity,
    });

    expect(view.id).toBe('tx-1');
  });

  it('fails with not found for a transaction of another provider', async () => {
    const uow = newUnitOfWork();
    seedTransaction(uow);

    expect(
      await rejection(
        new GetWagerTransactionUseCase(uow).execute({
          transactionId: 'tx-1',
          identity: providerIdentity('provider-2'),
        }),
      ),
    ).toBeInstanceOf(NotFoundError);
  });

  it('fails with not found when the transaction does not exist', async () => {
    const uow = newUnitOfWork();

    expect(
      await rejection(
        new GetWagerTransactionUseCase(uow).execute({
          transactionId: 'missing',
          identity: operatorIdentity,
        }),
      ),
    ).toBeInstanceOf(NotFoundError);
  });
});
