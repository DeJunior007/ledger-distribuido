import { describe, expect, it } from 'bun:test';
import { WagerTransactionFailed } from '@domain/messaging/events/wager-transaction-failed.event';
import { WagerTransactionPendingReference } from '@domain/messaging/events/wager-transaction-pending-reference.event';
import { WagerTransactionProcessed } from '@domain/messaging/events/wager-transaction-processed.event';
import { WagerTransactionRejected } from '@domain/messaging/events/wager-transaction-rejected.event';
import { WalletBalanceChanged } from '@domain/messaging/events/wallet-balance-changed.event';
import { IntegrationEvent, type EventContext } from '@domain/messaging/integration-event';
import { FailureAction, FailureCode } from '@domain/shared/failure-code';
import { Money } from '@domain/shared/money';
import { InvalidTransactionStateError } from '@domain/wagering/errors/invalid-transaction-state.error';
import {
  WagerTransaction,
  type CreateWagerTransactionProps,
} from '@domain/wagering/wager-transaction';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { LedgerDirection } from '@domain/wallet/ledger-direction';
import { Wallet } from '@domain/wallet/wallet';
import type { WalletLedgerEntry } from '@domain/wallet/wallet-ledger-entry';

const brl = (amount: string): Money => Money.fromSignedDecimal(amount, 'BRL');
const openedAt = new Date('2026-01-01T00:00:00.000Z');
const settledAt = new Date('2026-01-01T00:00:05.000Z');
const occurredAt = new Date('2026-01-01T00:00:06.123Z');
const deadlineAt = new Date('2026-01-01T00:05:05.000Z');

const ctx = (overrides: Partial<EventContext> = {}): EventContext => ({
  eventId: 'event-1',
  correlationId: 'corr-1',
  causationId: undefined,
  occurredAt,
  ...overrides,
});

const transactionProps = (
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps => ({
  id: 'tx-1',
  providerId: 'provider-1',
  externalTransactionId: 'ext-1',
  idempotencyKey: 'key-1',
  payloadHash: 'hash-1',
  walletId: 'wallet-1',
  playerId: 'player-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: WagerTransactionKind.Bet,
  money: brl('10.00'),
  referenceExternalTransactionId: undefined,
  correlationId: 'corr-1',
  now: openedAt,
  ...overrides,
});

const openWallet = (): Wallet =>
  Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl('100.00'),
    openingTransactionId: 'tx-opening',
    fundingAccountId: 'house-funding',
    walletEntryId: 'entry-opening',
    houseEntryId: 'house-entry-opening',
    now: openedAt,
  }).wallet;

const debitWallet = (wallet: Wallet): WalletLedgerEntry =>
  wallet.debit({
    transactionId: 'tx-1',
    money: brl('10.00'),
    houseAccountId: 'house-wagering',
    walletEntryId: 'entry-1',
    houseEntryId: 'house-entry-1',
    now: settledAt,
  }).walletEntry;

const processedBet = (): { transaction: WagerTransaction; wallet: Wallet } => {
  const wallet = openWallet();
  debitWallet(wallet);
  const transaction = WagerTransaction.create(transactionProps());
  transaction.markProcessed({
    referenceTransactionId: undefined,
    balanceSnapshot: wallet.balance,
    at: settledAt,
  });
  return { transaction, wallet };
};

const pendingRefund = (): WagerTransaction => {
  const transaction = WagerTransaction.create(
    transactionProps({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'ext-ref',
    }),
  );
  transaction.markPendingReference({ balanceSnapshot: brl('100.00'), at: settledAt });
  return transaction;
};

const containsMoney = (value: unknown): boolean => {
  if (value instanceof Money) {
    return true;
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(containsMoney);
  }
  return false;
};

const roundTrip = (event: IntegrationEvent<unknown>): unknown =>
  JSON.parse(JSON.stringify(event)) as unknown;

describe('IntegrationEvent envelope', () => {
  it('serializes occurredAt in ISO-8601 UTC and omits causationId when undefined', () => {
    const { transaction, wallet } = processedBet();
    const json = WagerTransactionProcessed.from(transaction, wallet, ctx()).toJSON();
    expect(json.occurredAt).toBe('2026-01-01T00:00:06.123Z');
    expect('causationId' in json).toBe(false);
  });

  it('includes causationId when present', () => {
    const { transaction, wallet } = processedBet();
    const event = WagerTransactionProcessed.from(
      transaction,
      wallet,
      ctx({ causationId: 'msg-1' }),
    );
    expect(event.causationId).toBe('msg-1');
    expect(event.toJSON().causationId).toBe('msg-1');
  });

  it('uses the wallet id as aggregate id and copies the context', () => {
    const { transaction, wallet } = processedBet();
    const event = WagerTransactionProcessed.from(transaction, wallet, ctx());
    expect(event).toBeInstanceOf(IntegrationEvent);
    expect(event.aggregateId).toBe('wallet-1');
    expect(event.eventId).toBe('event-1');
    expect(event.correlationId).toBe('corr-1');
    expect(event.occurredAt).toEqual(occurredAt);
  });

  it('keeps data frozen', () => {
    const { transaction, wallet } = processedBet();
    const event = WagerTransactionProcessed.from(transaction, wallet, ctx());
    expect(Object.isFrozen(event.data)).toBe(true);
  });
});

describe('WagerTransactionProcessed', () => {
  it('serializes to the documented shape', () => {
    const { transaction, wallet } = processedBet();
    const event = WagerTransactionProcessed.from(transaction, wallet, ctx());
    expect(event.eventType).toBe('WagerTransactionProcessed');
    expect(event.version).toBe(1);
    expect(event.toJSON()).toStrictEqual({
      eventId: 'event-1',
      eventType: 'WagerTransactionProcessed',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      occurredAt: '2026-01-01T00:00:06.123Z',
      version: 1,
      data: {
        transactionId: 'tx-1',
        walletId: 'wallet-1',
        providerId: 'provider-1',
        externalTransactionId: 'ext-1',
        playerId: 'player-1',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '10.00', currency: 'BRL' },
        balance: { amount: '90.00', currency: 'BRL' },
        walletVersion: 2,
        processedAt: '2026-01-01T00:00:05.000Z',
      },
    });
  });

  it('omits referenceTransactionId when the transaction has none', () => {
    const { transaction, wallet } = processedBet();
    const { data } = WagerTransactionProcessed.from(transaction, wallet, ctx()).toJSON();
    expect('referenceTransactionId' in data).toBe(false);
  });

  it('includes referenceTransactionId when the transaction has one', () => {
    const wallet = openWallet();
    const transaction = WagerTransaction.create(
      transactionProps({
        kind: WagerTransactionKind.Win,
        referenceExternalTransactionId: 'ext-ref',
      }),
    );
    transaction.markProcessed({
      referenceTransactionId: 'tx-ref',
      balanceSnapshot: wallet.balance,
      at: settledAt,
    });
    const { data } = WagerTransactionProcessed.from(transaction, wallet, ctx()).toJSON();
    expect(data.referenceTransactionId).toBe('tx-ref');
  });

  it('refuses a transaction that is not processed', () => {
    const transaction = WagerTransaction.create(transactionProps());
    expect(() => WagerTransactionProcessed.from(transaction, openWallet(), ctx())).toThrow(
      InvalidTransactionStateError,
    );
  });
});

describe('WagerTransactionRejected', () => {
  const rejectedBet = (referenceTransactionId: string | undefined): WagerTransaction => {
    const transaction = WagerTransaction.create(transactionProps({ money: brl('500.00') }));
    transaction.reject({
      failureCode: FailureCode.InsufficientFunds,
      referenceTransactionId,
      balanceSnapshot: brl('100.00'),
      at: settledAt,
    });
    return transaction;
  };

  it('serializes to the documented shape with failure metadata', () => {
    const event = WagerTransactionRejected.from(rejectedBet(undefined), openWallet(), ctx());
    expect(event.eventType).toBe('WagerTransactionRejected');
    expect(event.version).toBe(1);
    expect(event.toJSON()).toStrictEqual({
      eventId: 'event-1',
      eventType: 'WagerTransactionRejected',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      occurredAt: '2026-01-01T00:00:06.123Z',
      version: 1,
      data: {
        transactionId: 'tx-1',
        walletId: 'wallet-1',
        providerId: 'provider-1',
        externalTransactionId: 'ext-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '500.00', currency: 'BRL' },
        failureCode: FailureCode.InsufficientFunds,
        retryable: false,
        action: FailureAction.GiveUp,
        balance: { amount: '100.00', currency: 'BRL' },
        walletVersion: 1,
      },
    });
  });

  it('includes referenceTransactionId when the transaction has one', () => {
    const { data } = WagerTransactionRejected.from(
      rejectedBet('tx-ref'),
      openWallet(),
      ctx(),
    ).toJSON();
    expect(data.referenceTransactionId).toBe('tx-ref');
  });

  it('refuses a transaction that is not rejected', () => {
    const { transaction, wallet } = processedBet();
    expect(() => WagerTransactionRejected.from(transaction, wallet, ctx())).toThrow(
      InvalidTransactionStateError,
    );
  });
});

describe('WalletBalanceChanged', () => {
  it('serializes to the documented shape from the wallet and its ledger entry', () => {
    const wallet = openWallet();
    const entry = debitWallet(wallet);
    const event = WalletBalanceChanged.from(wallet, entry, ctx());
    expect(event.eventType).toBe('WalletBalanceChanged');
    expect(event.version).toBe(1);
    expect(event.toJSON()).toStrictEqual({
      eventId: 'event-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      occurredAt: '2026-01-01T00:00:06.123Z',
      version: 1,
      data: {
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: { amount: '10.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '90.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });
});

describe('WagerTransactionPendingReference', () => {
  it('serializes to the documented shape with the deadline in ISO', () => {
    const event = WagerTransactionPendingReference.from(
      pendingRefund(),
      openWallet(),
      deadlineAt,
      ctx(),
    );
    expect(event.eventType).toBe('WagerTransactionPendingReference');
    expect(event.version).toBe(1);
    expect(event.toJSON()).toStrictEqual({
      eventId: 'event-1',
      eventType: 'WagerTransactionPendingReference',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      occurredAt: '2026-01-01T00:00:06.123Z',
      version: 1,
      data: {
        transactionId: 'tx-1',
        walletId: 'wallet-1',
        providerId: 'provider-1',
        externalTransactionId: 'ext-1',
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'ext-ref',
        deadlineAt: '2026-01-01T00:05:05.000Z',
        walletVersion: 1,
      },
    });
  });

  it('refuses a transaction that is not pending a reference', () => {
    const { transaction, wallet } = processedBet();
    expect(() =>
      WagerTransactionPendingReference.from(transaction, wallet, deadlineAt, ctx()),
    ).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransactionFailed', () => {
  it('serializes to the documented shape', () => {
    const transaction = pendingRefund();
    transaction.fail({ balanceSnapshot: brl('100.00'), at: settledAt });
    const event = WagerTransactionFailed.from(transaction, openWallet(), ctx());
    expect(event.eventType).toBe('WagerTransactionFailed');
    expect(event.version).toBe(1);
    expect(event.toJSON()).toStrictEqual({
      eventId: 'event-1',
      eventType: 'WagerTransactionFailed',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      occurredAt: '2026-01-01T00:00:06.123Z',
      version: 1,
      data: {
        transactionId: 'tx-1',
        walletId: 'wallet-1',
        providerId: 'provider-1',
        externalTransactionId: 'ext-1',
        kind: WagerTransactionKind.Refund,
        failureCode: 'PROCESSING_FAILED',
        walletVersion: 1,
      },
    });
  });

  it('refuses a transaction that is not failed', () => {
    expect(() => WagerTransactionFailed.from(pendingRefund(), openWallet(), ctx())).toThrow(
      InvalidTransactionStateError,
    );
  });
});

describe('event data stability', () => {
  const allEvents = (): IntegrationEvent<unknown>[] => {
    const { transaction, wallet } = processedBet();
    const rejected = WagerTransaction.create(transactionProps());
    rejected.reject({
      failureCode: FailureCode.InsufficientFunds,
      referenceTransactionId: undefined,
      balanceSnapshot: brl('100.00'),
      at: settledAt,
    });
    const failed = pendingRefund();
    failed.fail({ balanceSnapshot: brl('100.00'), at: settledAt });
    const changedWallet = openWallet();
    const entry = debitWallet(changedWallet);
    return [
      WagerTransactionProcessed.from(transaction, wallet, ctx({ causationId: 'msg-1' })),
      WagerTransactionRejected.from(rejected, openWallet(), ctx()),
      WalletBalanceChanged.from(changedWallet, entry, ctx()),
      WagerTransactionPendingReference.from(pendingRefund(), openWallet(), deadlineAt, ctx()),
      WagerTransactionFailed.from(failed, openWallet(), ctx()),
    ];
  };

  it('never holds a Money instance in data', () => {
    for (const event of allEvents()) {
      expect(containsMoney(event.data)).toBe(false);
      expect(containsMoney(event.toJSON())).toBe(false);
    }
  });

  it('round-trips through JSON without changes', () => {
    for (const event of allEvents()) {
      expect(roundTrip(event)).toStrictEqual(event.toJSON());
    }
  });
});
