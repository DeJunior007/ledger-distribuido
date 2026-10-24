import { InMemoryUnitOfWork } from '@test/support/fakes/in-memory-unit-of-work.fake';
import { FixedClock } from '@test/support/fixed-clock';
import { toCurrencyCode } from '@domain/shared/currency';
import { Money } from '@domain/shared/money';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '@domain/wagering/wager-transaction-status';
import { LedgerDirection } from '@domain/wallet/ledger-direction';
import type { Identity } from '@application/ports/provider-identity.port';

export const at = new Date('2026-01-01T00:00:00.000Z');
export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

export const providerIdentity = (providerId: string): Identity => ({
  kind: 'provider',
  providerId,
  clientId: `client-${providerId}`,
});
export const operatorIdentity: Identity = { kind: 'operator', clientId: 'operator-1' };

export const newUnitOfWork = (): InMemoryUnitOfWork => new InMemoryUnitOfWork(new FixedClock(at));

export const seedWallet = (uow: InMemoryUnitOfWork, id = 'wallet-1'): void => {
  uow.database.wallets.put({
    id,
    playerId: 'player-1',
    currency: toCurrencyCode('BRL'),
    balance: brl('50.00'),
    version: 3,
    createdAt: at,
    updatedAt: at,
  });
};

export const seedTransaction = (
  uow: InMemoryUnitOfWork,
  providerId = 'provider-1',
  externalTransactionId = 'ext-1',
): void => {
  uow.database.transactions.put({
    id: 'tx-1',
    providerId,
    externalTransactionId,
    idempotencyKey: 'key-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: brl('10.00'),
    referenceExternalTransactionId: undefined,
    referenceTransactionId: undefined,
    status: WagerTransactionStatus.Processed,
    failureCode: undefined,
    balanceSnapshot: brl('40.00'),
    correlationId: 'corr-1',
    createdAt: at,
    processedAt: at,
    updatedAt: at,
  });
};

export const seedEntries = (uow: InMemoryUnitOfWork, count: number): void => {
  for (let version = 1; version <= count; version += 1) {
    uow.database.walletEntries.put({
      id: `entry-${String(version)}`,
      walletId: 'wallet-1',
      transactionId: `tx-${String(version)}`,
      direction: LedgerDirection.Credit,
      money: brl('1.00'),
      balanceBefore: brl(`${String(version - 1)}.00`),
      balanceAfter: brl(`${String(version)}.00`),
      walletVersion: version,
      createdAt: at,
    });
  }
};

export const rejection = async (pending: Promise<unknown>): Promise<unknown> => {
  try {
    await pending;
  } catch (error) {
    return error;
  }
  return undefined;
};
