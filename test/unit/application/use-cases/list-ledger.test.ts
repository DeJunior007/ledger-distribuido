import { describe, expect, it } from 'bun:test';
import { LedgerDirection } from '@domain/wallet/ledger-direction';
import { NotFoundError } from '@application/errors/not-found.error';
import { ListLedgerUseCase } from '@application/use-cases/list-ledger.use-case';
import { newUnitOfWork, seedEntries, seedWallet, rejection } from './fixtures';

describe('ListLedgerUseCase', () => {
  it('returns a next cursor when more rows exist than the limit', async () => {
    const uow = newUnitOfWork();
    seedWallet(uow);
    seedEntries(uow, 5);

    const page = await new ListLedgerUseCase(uow).execute({
      walletId: 'wallet-1',
      beforeVersion: undefined,
      limit: 2,
    });

    expect(page.entries.map((entry) => entry.walletVersion)).toStrictEqual([5, 4]);
    expect(page.nextBeforeVersion).toBe(4);
    expect(page.entries[0]).toStrictEqual({
      id: 'entry-5',
      transactionId: 'tx-5',
      direction: LedgerDirection.Credit,
      money: { amount: '1.00', currency: 'BRL' },
      balanceBefore: { amount: '4.00', currency: 'BRL' },
      balanceAfter: { amount: '5.00', currency: 'BRL' },
      walletVersion: 5,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('has no next cursor on the last page', async () => {
    const uow = newUnitOfWork();
    seedWallet(uow);
    seedEntries(uow, 5);

    const page = await new ListLedgerUseCase(uow).execute({
      walletId: 'wallet-1',
      beforeVersion: 4,
      limit: 3,
    });

    expect(page.entries.map((entry) => entry.walletVersion)).toStrictEqual([3, 2, 1]);
    expect(page.nextBeforeVersion).toBeUndefined();
  });

  it('has no next cursor when the rows fit exactly in the limit', async () => {
    const uow = newUnitOfWork();
    seedWallet(uow);
    seedEntries(uow, 2);

    const page = await new ListLedgerUseCase(uow).execute({
      walletId: 'wallet-1',
      beforeVersion: undefined,
      limit: 2,
    });

    expect(page.entries).toHaveLength(2);
    expect(page.nextBeforeVersion).toBeUndefined();
  });

  it('fails with not found when the wallet does not exist', async () => {
    const uow = newUnitOfWork();

    expect(
      await rejection(
        new ListLedgerUseCase(uow).execute({
          walletId: 'missing',
          beforeVersion: undefined,
          limit: 2,
        }),
      ),
    ).toBeInstanceOf(NotFoundError);
  });
});
