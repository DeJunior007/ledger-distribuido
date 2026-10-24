import { toCurrencyCode } from '@domain/shared/currency';
import { Money } from '@domain/shared/money';
import type { IdempotencyRecordState } from '@domain/idempotency/idempotency-record';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import type { WagerTransactionState } from '@domain/wagering/wager-transaction';
import { WagerTransactionStatus } from '@domain/wagering/wager-transaction-status';
import { HouseAccountPurpose } from '@domain/wallet/house-account';
import type { PendingReferenceRetry } from '@application/ports/repositories/pending-reference-repository.port';
import { OutcomeMapper } from '@application/services/outcome-mapper';
import { FakeFaultInjector } from '@test/support/fakes/fault-injector.fake';
import { InMemoryUnitOfWork } from '@test/support/fakes/in-memory-unit-of-work.fake';
import { FakeLogger } from '@test/support/fakes/logger.fake';
import { FakeMetrics } from '@test/support/fakes/metrics.fake';
import { FakeTracer } from '@test/support/fakes/tracer.fake';
import { FixedClock } from '@test/support/fixed-clock';
import { SequentialIds } from '@test/support/sequential-ids';

export const PENDING_TTL_MS = 3_000;
export const PENDING_LEASE_MS = 30_000;
export const INSTANCE_ID = 'instance-1';
export const createdAt = new Date('2026-05-01T10:00:00.000Z');
export const deadlineAt = new Date(createdAt.getTime() + PENDING_TTL_MS);

export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

export interface PendingHarness {
  clock: FixedClock;
  uow: InMemoryUnitOfWork;
  ids: SequentialIds;
  faults: FakeFaultInjector;
  logger: FakeLogger;
  metrics: FakeMetrics;
  tracer: FakeTracer;
  outcomeMapper: OutcomeMapper;
  enriched: Record<string, string>[];
}

export const createHarness = (): PendingHarness => {
  const clock = new FixedClock(new Date(createdAt.getTime() + 1_000));
  const uow = new InMemoryUnitOfWork(clock);
  uow.database.wallets.put({
    id: 'wallet-1',
    playerId: 'player-1',
    currency: toCurrencyCode('BRL'),
    balance: brl('100.00'),
    version: 2,
    createdAt,
    updatedAt: createdAt,
  });
  for (const purpose of [HouseAccountPurpose.Gaming, HouseAccountPurpose.Funding]) {
    uow.database.houseAccounts.put({
      id: `house-${purpose}`,
      currency: toCurrencyCode('BRL'),
      purpose,
      createdAt,
    });
  }
  return {
    clock,
    uow,
    ids: new SequentialIds(),
    faults: new FakeFaultInjector(),
    logger: new FakeLogger(),
    metrics: new FakeMetrics(),
    tracer: new FakeTracer(),
    outcomeMapper: new OutcomeMapper(),
    enriched: [],
  };
};

export const transactionState = (
  overrides: Partial<WagerTransactionState> & Pick<WagerTransactionState, 'id' | 'kind'>,
): WagerTransactionState => ({
  providerId: 'provider-1',
  externalTransactionId: `ext-${overrides.id}`,
  idempotencyKey: `key-${overrides.id}`,
  payloadHash: `hash-${overrides.id}`,
  walletId: 'wallet-1',
  playerId: 'player-1',
  roundId: 'round-1',
  gameId: 'game-1',
  money: brl('30.00'),
  referenceExternalTransactionId: undefined,
  referenceTransactionId: undefined,
  status: WagerTransactionStatus.Processed,
  failureCode: undefined,
  balanceSnapshot: brl('100.00'),
  correlationId: `corr-${overrides.id}`,
  createdAt,
  processedAt: createdAt,
  updatedAt: createdAt,
  ...overrides,
});

export const seedBet = (
  harness: PendingHarness,
  status: WagerTransactionStatus = WagerTransactionStatus.Processed,
): void => {
  const pending = status === WagerTransactionStatus.PendingReference;
  harness.uow.database.transactions.put(
    transactionState({
      id: 'bet-1',
      kind: WagerTransactionKind.Bet,
      status,
      processedAt: pending ? undefined : createdAt,
      ...(pending ? { referenceExternalTransactionId: 'ext-missing' } : {}),
    }),
  );
  seedRecord(harness, 'bet-1', pending ? 202 : 200);
};

export const seedPending = (
  harness: PendingHarness,
  overrides: Partial<WagerTransactionState> & Pick<WagerTransactionState, 'id' | 'kind'>,
  retry: Partial<PendingReferenceRetry> = {},
): void => {
  harness.uow.database.transactions.put(
    transactionState({
      referenceExternalTransactionId: 'ext-bet-1',
      status: WagerTransactionStatus.PendingReference,
      processedAt: undefined,
      ...overrides,
    }),
  );
  seedRecord(harness, overrides.id, 202);
  harness.uow.database.pendingReferences.put(pendingRetry(overrides.id, retry));
};

export const seedRecord = (
  harness: PendingHarness,
  transactionId: string,
  httpStatus: IdempotencyRecordState['httpStatus'],
): void => {
  harness.uow.database.idempotency.put({
    providerId: 'provider-1',
    idempotencyKey: `key-${transactionId}`,
    payloadHash: `hash-${transactionId}`,
    transactionId,
    httpStatus,
    responseBody: {
      transactionId,
      status: httpStatus === 202 ? 'PENDING_REFERENCE' : 'PROCESSED',
      kind: WagerTransactionKind.Bet,
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: false,
    },
    createdAt,
    updatedAt: createdAt,
  });
};

export const pendingRetry = (
  transactionId: string,
  overrides: Partial<PendingReferenceRetry> = {},
): PendingReferenceRetry => ({
  transactionId,
  attempts: 0,
  consecutiveErrors: 0,
  nextAttemptAt: new Date(createdAt.getTime() + 1_000),
  deadlineAt,
  lockedUntil: new Date(createdAt.getTime() + PENDING_LEASE_MS),
  lockedBy: INSTANCE_ID,
  resolvedAt: undefined,
  createdAt,
  ...overrides,
});

export const storedRetry = (
  harness: PendingHarness,
  transactionId: string,
): PendingReferenceRetry => required(harness.uow.database.pendingReferences.get(transactionId));

export const storedTransaction = (
  harness: PendingHarness,
  transactionId: string,
): WagerTransactionState => required(harness.uow.database.transactions.get(transactionId));

export const storedRecord = (
  harness: PendingHarness,
  transactionId: string,
): IdempotencyRecordState =>
  required(
    harness.uow.database.idempotency
      .rows()
      .find((row) => row.idempotencyKey === `key-${transactionId}`),
  );

export const outboxEvents = (harness: PendingHarness): Readonly<Record<string, unknown>>[] =>
  harness.uow.database.outbox.rows().map((row) => row.payload);

export const required = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new TypeError('expected a value');
  }
  return value;
};
