import { describe, expect, it } from 'bun:test';
import type {
  SubmitResult,
  SubmitWagerTransactionCommand,
} from '@application/commands/submit-wager-transaction.command';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import { TRUSTED_CHANNEL } from '@application/ports/provider-identity.port';
import { AnomalyDetector } from '@application/services/anomaly-detector';
import { OutcomeMapper } from '@application/services/outcome-mapper';
import { computePayloadHash } from '@application/services/payload-hash';
import { SUBMISSION_CONSUMER } from '@application/services/submission-fast-path';
import { SubmitWagerTransactionUseCase } from '@application/use-cases/submit-wager-transaction.use-case';
import { IdempotencyRecord } from '@domain/idempotency/idempotency-record';
import type { TransactionResultBody } from '@domain/idempotency/response-bodies';
import { InboxMessage } from '@domain/messaging/inbox-message';
import { toCurrencyCode } from '@domain/shared/currency';
import { FailureAction, FailureCode } from '@domain/shared/failure-code';
import { Money } from '@domain/shared/money';
import { TransactionApplier } from '@domain/wagering/transaction-applier';
import type { WagerTransactionState } from '@domain/wagering/wager-transaction';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '@domain/wagering/wager-transaction-status';
import { HouseAccountPurpose } from '@domain/wallet/house-account';
import { LedgerDirection } from '@domain/wallet/ledger-direction';
import { Sha256Hasher } from '@infrastructure/system/sha256-hasher';
import { FakeFaultInjector, InjectedFaultError } from '@test/support/fakes/fault-injector.fake';
import { InMemoryUnitOfWork } from '@test/support/fakes/in-memory-unit-of-work.fake';
import { FakeLogger } from '@test/support/fakes/logger.fake';
import { FakeMetrics } from '@test/support/fakes/metrics.fake';
import { FakeTracer } from '@test/support/fakes/tracer.fake';
import { FixedClock } from '@test/support/fixed-clock';
import { SequentialIds } from '@test/support/sequential-ids';

const now = new Date('2026-03-01T12:00:00.000Z');
const pendingTtlMs = 900_000;
const hasher = new Sha256Hasher();
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

type EnrichedFields = Parameters<
  ConstructorParameters<typeof SubmitWagerTransactionUseCase>[0]['enrich']
>[0];

interface Harness {
  readonly uow: InMemoryUnitOfWork;
  readonly metrics: FakeMetrics;
  readonly logger: FakeLogger;
  readonly faults: FakeFaultInjector;
  readonly enriched: EnrichedFields[];
  readonly useCase: SubmitWagerTransactionUseCase;
}

const harness = (): Harness => {
  const clock = new FixedClock(now);
  const uow = new InMemoryUnitOfWork(clock);
  const metrics = new FakeMetrics();
  const logger = new FakeLogger();
  const faults = new FakeFaultInjector();
  const enriched: EnrichedFields[] = [];
  const useCase = new SubmitWagerTransactionUseCase(
    {
      uow,
      clock,
      ids: new SequentialIds(),
      hasher,
      faults,
      logger,
      metrics,
      tracer: new FakeTracer(),
      enrich: (fields) => {
        enriched.push(fields);
      },
      applier: TransactionApplier.create(),
      outcomeMapper: new OutcomeMapper(),
      anomalyDetector: new AnomalyDetector(),
    },
    { pendingTtlMs },
  );
  uow.database.wallets.put({
    id: 'wallet-1',
    playerId: 'player-1',
    currency: toCurrencyCode('BRL'),
    balance: brl('100.00'),
    version: 4,
    createdAt: now,
    updatedAt: now,
  });
  uow.database.houseAccounts.put({
    id: 'gaming-brl',
    currency: toCurrencyCode('BRL'),
    purpose: HouseAccountPurpose.Gaming,
    createdAt: now,
  });
  return { uow, metrics, logger, faults, enriched, useCase };
};

const httpCommand = (
  overrides: Partial<SubmitWagerTransactionCommand> = {},
): SubmitWagerTransactionCommand => ({
  channel: 'http',
  identity: { kind: 'provider', providerId: 'provider-1', clientId: 'client-1' },
  providerId: 'provider-1',
  externalTransactionId: 'ext-1',
  idempotencyKey: 'key-1',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: WagerTransactionKind.Bet,
  money: { amount: '10.00', currency: 'BRL' },
  referenceExternalTransactionId: undefined,
  correlationId: 'correlation-1',
  causationId: 'causation-1',
  inbox: undefined,
  ...overrides,
});

const sqsCommand = (
  overrides: Partial<SubmitWagerTransactionCommand> = {},
): SubmitWagerTransactionCommand =>
  httpCommand({
    channel: 'sqs',
    identity: TRUSTED_CHANNEL,
    inbox: { messageId: 'message-1', payloadHash: 'inbox-hash-1' },
    ...overrides,
  });

const storedTransaction = (overrides: Partial<WagerTransactionState>): WagerTransactionState => ({
  id: 'tx-bet',
  providerId: 'provider-1',
  externalTransactionId: 'ext-bet',
  idempotencyKey: 'key-bet',
  payloadHash: 'hash-bet',
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
  balanceSnapshot: brl('100.00'),
  correlationId: 'correlation-bet',
  createdAt: now,
  processedAt: now,
  updatedAt: now,
  ...overrides,
});

const eventTypes = (uow: InMemoryUnitOfWork): string[] =>
  uow.database.outbox.rows().map((row) => row.eventType);

const outcomeOf = (result: SubmitResult): { httpStatus: number; body: TransactionResultBody } => {
  if (result.kind !== 'outcome') {
    throw new TechnicalError(ErrorClass.Deterministic, 'deterministic');
  }
  return { httpStatus: result.httpStatus, body: result.body };
};

const captureError = async (action: () => Promise<unknown>): Promise<unknown> => {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return undefined;
};

const recordFor = (
  command: SubmitWagerTransactionCommand,
  body: TransactionResultBody,
): IdempotencyRecord =>
  IdempotencyRecord.create({
    providerId: command.providerId,
    idempotencyKey: command.idempotencyKey,
    payloadHash: computePayloadHash(command, hasher),
    transactionId: 'tx-competitor',
    httpStatus: 200,
    responseBody: body,
    createdAt: now,
  });

const competitorBody = (): TransactionResultBody => ({
  transactionId: 'tx-competitor',
  status: 'PROCESSED',
  kind: WagerTransactionKind.Bet,
  balance: { amount: '90.00', currency: 'BRL' },
  idempotentReplay: false,
});

const expectNothingPersisted = (uow: InMemoryUnitOfWork): void => {
  expect(uow.database.transactions.rows()).toHaveLength(0);
  expect(uow.database.walletEntries.rows()).toHaveLength(0);
  expect(uow.database.houseEntries.rows()).toHaveLength(0);
  expect(uow.database.outbox.rows()).toHaveLength(0);
  expect(uow.database.idempotency.rows()).toHaveLength(0);
  expect(uow.database.inbox.rows()).toHaveLength(0);
  expect(uow.database.wallets.get('wallet-1')?.version).toBe(4);
};

describe('SubmitWagerTransactionUseCase apply and persist', () => {
  describe('PROCESSED with a posting', () => {
    it('stores the transaction, posting, wallet version, events and record', async () => {
      const { uow, metrics, enriched, useCase } = harness();
      const command = httpCommand();

      const result = await useCase.execute(command);

      const { httpStatus, body } = outcomeOf(result);
      const [stored] = uow.database.transactions.rows();
      expect(httpStatus).toBe(200);
      expect(result.kind === 'outcome' && result.replay).toBe(false);
      expect(body).toEqual({
        transactionId: stored?.id ?? null,
        status: 'PROCESSED',
        kind: WagerTransactionKind.Bet,
        balance: { amount: '90.00', currency: 'BRL' },
        idempotentReplay: false,
      });
      expect(stored?.status).toBe(WagerTransactionStatus.Processed);
      expect(stored?.payloadHash).toBe(computePayloadHash(command, hasher));
      expect(stored?.correlationId).toBe('correlation-1');
      expect(enriched).toContainEqual({ transactionId: stored?.id ?? '' });
      const wallet = uow.database.wallets.get('wallet-1');
      expect(wallet?.version).toBe(5);
      expect(wallet?.balance.equals(brl('90.00'))).toBe(true);
      const [walletEntry] = uow.database.walletEntries.rows();
      expect(walletEntry?.direction).toBe(LedgerDirection.Debit);
      expect(walletEntry?.walletVersion).toBe(5);
      expect(walletEntry?.transactionId).toBe(stored?.id);
      const [houseEntry] = uow.database.houseEntries.rows();
      expect(houseEntry?.houseAccountId).toBe('gaming-brl');
      expect(eventTypes(uow)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
      for (const row of uow.database.outbox.rows()) {
        expect(row.payload.correlationId).toBe('correlation-1');
        expect(row.payload.causationId).toBe('causation-1');
      }
      expect(uow.database.idempotency.rows()).toEqual([
        {
          providerId: 'provider-1',
          idempotencyKey: 'key-1',
          payloadHash: computePayloadHash(command, hasher),
          transactionId: stored?.id,
          httpStatus: 200,
          responseBody: body,
          createdAt: now,
          updatedAt: now,
        },
      ]);
      expect(uow.database.pendingReferences.rows()).toHaveLength(0);
      expect(
        metrics.counter('wager_transactions_total', {
          status: 'PROCESSED',
          kind: 'BET',
          channel: 'http',
          failure_code: 'none',
        }),
      ).toBe(1);
      expect(
        metrics.observations('wager_processing_duration_seconds', {
          channel: 'http',
          status: 'PROCESSED',
        }),
      ).toHaveLength(1);
      expect(metrics.observations('wallet_lock_wait_seconds', { channel: 'http' })).toHaveLength(1);
    });

    it('marks the inbox as processed in the same transaction on sqs', async () => {
      const { uow, metrics, useCase } = harness();

      const result = await useCase.execute(sqsCommand());

      expect(outcomeOf(result).httpStatus).toBe(200);
      expect(uow.database.inbox.rows()).toEqual([
        {
          consumerName: SUBMISSION_CONSUMER,
          messageId: 'message-1',
          payloadHash: 'inbox-hash-1',
          receivedAt: now,
          processedAt: now,
        },
      ]);
      expect(
        metrics.counter('wager_transactions_total', {
          status: 'PROCESSED',
          kind: 'BET',
          channel: 'sqs',
          failure_code: 'none',
        }),
      ).toBe(1);
    });

    it('replays the stored outcome on the next submission', async () => {
      const { uow, useCase } = harness();
      const first = await useCase.execute(httpCommand());

      const replayed = await useCase.execute(httpCommand());

      expect(replayed).toEqual({
        kind: 'outcome',
        httpStatus: 200,
        body: { ...outcomeOf(first).body, idempotentReplay: true },
        replay: true,
      });
      expect(uow.database.transactions.rows()).toHaveLength(1);
      expect(uow.database.wallets.get('wallet-1')?.version).toBe(5);
    });
  });

  describe('PROCESSED without a posting', () => {
    it('stores a LOSS on a processed BET with only the processed event', async () => {
      const { uow, useCase } = harness();
      uow.database.transactions.put(storedTransaction({}));

      const result = await useCase.execute(
        httpCommand({
          kind: WagerTransactionKind.Loss,
          money: { amount: '0.00', currency: 'BRL' },
          referenceExternalTransactionId: 'ext-bet',
        }),
      );

      const { httpStatus, body } = outcomeOf(result);
      expect(httpStatus).toBe(200);
      expect(body.status).toBe('PROCESSED');
      expect(body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(eventTypes(uow)).toEqual(['WagerTransactionProcessed']);
      expect(uow.database.walletEntries.rows()).toHaveLength(0);
      expect(uow.database.wallets.get('wallet-1')?.version).toBe(4);
      expect(uow.database.idempotency.rows()[0]?.httpStatus).toBe(200);
    });
  });

  describe('REJECTED', () => {
    it('stores a rejected transaction when the balance is insufficient', async () => {
      const { uow, metrics, useCase } = harness();

      const result = await useCase.execute(
        httpCommand({ money: { amount: '150.00', currency: 'BRL' } }),
      );

      const { httpStatus, body } = outcomeOf(result);
      const [stored] = uow.database.transactions.rows();
      expect(httpStatus).toBe(422);
      expect(body).toEqual({
        transactionId: stored?.id ?? null,
        status: 'REJECTED',
        kind: WagerTransactionKind.Bet,
        failureCode: FailureCode.InsufficientFunds,
        retryable: false,
        action: FailureAction.GiveUp,
        balance: { amount: '100.00', currency: 'BRL' },
        idempotentReplay: false,
      });
      expect(stored?.status).toBe(WagerTransactionStatus.Rejected);
      expect(eventTypes(uow)).toEqual(['WagerTransactionRejected']);
      expect(uow.database.walletEntries.rows()).toHaveLength(0);
      expect(uow.database.wallets.get('wallet-1')?.version).toBe(4);
      expect(uow.database.idempotency.rows()[0]?.httpStatus).toBe(422);
      expect(uow.database.idempotency.rows()[0]?.transactionId).toBe(stored?.id);
      expect(
        metrics.counter('wager_transactions_total', {
          status: 'REJECTED',
          kind: 'BET',
          channel: 'http',
          failure_code: 'INSUFFICIENT_FUNDS',
        }),
      ).toBe(1);
    });

    it('rejects a player that does not own the wallet before looking at references', async () => {
      const { uow, useCase } = harness();

      const result = await useCase.execute(
        httpCommand({
          playerId: 'player-2',
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: 'ext-missing',
        }),
      );

      expect(outcomeOf(result).body.failureCode).toBe(FailureCode.PlayerWalletMismatch);
      expect(eventTypes(uow)).toEqual(['WagerTransactionRejected']);
      expect(uow.database.pendingReferences.rows()).toHaveLength(0);
    });

    it('rejects a reversal of a reference that was already reversed', async () => {
      const { uow, useCase } = harness();
      uow.database.transactions.put(storedTransaction({}));
      uow.database.transactions.put(
        storedTransaction({
          id: 'tx-refund',
          externalTransactionId: 'ext-refund',
          idempotencyKey: 'key-refund',
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: 'ext-bet',
          referenceTransactionId: 'tx-bet',
        }),
      );

      const result = await useCase.execute(
        httpCommand({
          kind: WagerTransactionKind.Rollback,
          referenceExternalTransactionId: 'ext-bet',
        }),
      );

      expect(outcomeOf(result).body.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
      expect(eventTypes(uow)).toEqual(['WagerTransactionRejected']);
    });
  });

  describe('PENDING_REFERENCE', () => {
    it('stores the retry row, the pending event and a 202 record', async () => {
      const { uow, metrics, useCase } = harness();
      const command = sqsCommand({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'ext-bet',
      });

      const result = await useCase.execute(command);

      const { httpStatus, body } = outcomeOf(result);
      const [stored] = uow.database.transactions.rows();
      const deadlineAt = new Date(now.getTime() + pendingTtlMs);
      expect(httpStatus).toBe(202);
      expect(body.status).toBe('PENDING_REFERENCE');
      expect(body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(stored?.status).toBe(WagerTransactionStatus.PendingReference);
      expect(uow.database.pendingReferences.rows()).toEqual([
        {
          transactionId: stored?.id ?? '',
          attempts: 0,
          consecutiveErrors: 0,
          nextAttemptAt: new Date(now.getTime() + 1000),
          deadlineAt,
          createdAt: now,
          lockedUntil: undefined,
          lockedBy: undefined,
          resolvedAt: undefined,
        },
      ]);
      expect(eventTypes(uow)).toEqual(['WagerTransactionPendingReference']);
      const data = uow.database.outbox.rows()[0]?.payload.data;
      expect(data).toMatchObject({ deadlineAt: deadlineAt.toISOString() });
      expect(uow.database.idempotency.rows()[0]?.httpStatus).toBe(202);
      expect(uow.database.inbox.rows()[0]?.processedAt).toEqual(now);
      expect(uow.database.walletEntries.rows()).toHaveLength(0);
      expect(uow.database.wallets.get('wallet-1')?.version).toBe(4);
      expect(
        metrics.counter('wager_transactions_total', {
          status: 'PENDING_REFERENCE',
          kind: 'REFUND',
          channel: 'sqs',
          failure_code: 'none',
        }),
      ).toBe(1);
    });
  });

  describe('wake-up of dependents', () => {
    const seedWaitingRefund = (uow: InMemoryUnitOfWork): void => {
      uow.database.transactions.put(
        storedTransaction({
          id: 'tx-waiting',
          externalTransactionId: 'ext-waiting',
          idempotencyKey: 'key-waiting',
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: 'ext-1',
          status: WagerTransactionStatus.PendingReference,
          processedAt: undefined,
        }),
      );
      uow.database.pendingReferences.put({
        transactionId: 'tx-waiting',
        attempts: 2,
        consecutiveErrors: 0,
        nextAttemptAt: new Date(now.getTime() + 60_000),
        deadlineAt: new Date(now.getTime() + pendingTtlMs),
        createdAt: now,
        lockedUntil: undefined,
        lockedBy: undefined,
        resolvedAt: undefined,
      });
    };

    it('brings the next attempt of dependents forward when the reference is processed', async () => {
      const { uow, useCase } = harness();
      seedWaitingRefund(uow);

      await useCase.execute(httpCommand());

      expect(uow.database.pendingReferences.get('tx-waiting')?.nextAttemptAt).toEqual(now);
    });

    it('leaves dependents alone when the reference is rejected', async () => {
      const { uow, useCase } = harness();
      seedWaitingRefund(uow);

      await useCase.execute(httpCommand({ money: { amount: '150.00', currency: 'BRL' } }));

      expect(uow.database.pendingReferences.get('tx-waiting')?.nextAttemptAt).toEqual(
        new Date(now.getTime() + 60_000),
      );
    });
  });

  describe('reversal after win anomaly', () => {
    const seedRoundWithWin = (uow: InMemoryUnitOfWork): void => {
      uow.database.transactions.put(storedTransaction({}));
      uow.database.transactions.put(
        storedTransaction({
          id: 'tx-win',
          externalTransactionId: 'ext-win',
          idempotencyKey: 'key-win',
          kind: WagerTransactionKind.Win,
          referenceExternalTransactionId: 'ext-bet',
          referenceTransactionId: 'tx-bet',
        }),
      );
    };

    const refundOfBet = (): SubmitWagerTransactionCommand =>
      httpCommand({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ext-bet' });

    it('emits the anomaly metric and a warning after the commit', async () => {
      const { uow, metrics, logger, useCase } = harness();
      seedRoundWithWin(uow);

      const result = await useCase.execute(refundOfBet());

      expect(outcomeOf(result).body.status).toBe('PROCESSED');
      expect(metrics.counter('wager_anomaly_total', { type: 'reversal_after_win' })).toBe(1);
      const warnings = logger.entriesAt('warn');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.fields).toMatchObject({
        correlationId: 'correlation-1',
        walletId: 'wallet-1',
        providerId: 'provider-1',
      });
    });

    it('does not flag a refund when the round has no processed win', async () => {
      const { uow, metrics, logger, useCase } = harness();
      uow.database.transactions.put(storedTransaction({}));

      await useCase.execute(refundOfBet());

      expect(metrics.counter('wager_anomaly_total', { type: 'reversal_after_win' })).toBe(0);
      expect(logger.entriesAt('warn')).toHaveLength(0);
    });

    it('does not emit the anomaly when the commit does not happen', async () => {
      const { uow, metrics, logger, faults, useCase } = harness();
      seedRoundWithWin(uow);
      faults.arm('api.before_commit');

      const error = await captureError(() => useCase.execute(refundOfBet()));

      expect(error).toBeInstanceOf(InjectedFaultError);
      expect(metrics.counter('wager_anomaly_total', { type: 'reversal_after_win' })).toBe(0);
      expect(logger.entriesAt('warn')).toHaveLength(0);
      expect(uow.database.transactions.rows()).toHaveLength(2);
    });
  });

  describe('fault points before the commit', () => {
    it('hits api.before_commit on http and rolls everything back', async () => {
      const { uow, metrics, faults, useCase } = harness();
      faults.arm('api.before_commit');

      const error = await captureError(() => useCase.execute(httpCommand()));

      expect(error).toBeInstanceOf(InjectedFaultError);
      expect(faults.hits).toEqual(['api.before_commit']);
      expectNothingPersisted(uow);
      expect(
        metrics.counter('wager_transactions_total', {
          status: 'PROCESSED',
          kind: 'BET',
          channel: 'http',
          failure_code: 'none',
        }),
      ).toBe(0);
      expect(metrics.observations('wallet_lock_wait_seconds', { channel: 'http' })).toHaveLength(0);
    });

    it('hits consumer.before_commit on sqs and leaves the inbox empty', async () => {
      const { uow, faults, useCase } = harness();
      faults.arm('consumer.before_commit');

      const error = await captureError(() => useCase.execute(sqsCommand()));

      expect(error).toBeInstanceOf(InjectedFaultError);
      expect(faults.hits).toEqual(['consumer.before_commit']);
      expectNothingPersisted(uow);
    });
  });

  describe('race on a unique constraint', () => {
    it('starts over from the fast path once and replays the competing outcome', async () => {
      const { uow, metrics, useCase } = harness();
      const command = httpCommand();
      uow.interceptNextCommit(() => {
        uow.database.idempotency.put(recordFor(command, competitorBody()).toState());
        return Promise.resolve();
      });

      const result = await useCase.execute(command);

      expect(result).toEqual({
        kind: 'outcome',
        httpStatus: 200,
        body: { ...competitorBody(), idempotentReplay: true },
        replay: true,
      });
      expect(metrics.counter('lock_conflicts_total', { type: 'unique_retry' })).toBe(1);
      expect(metrics.counter('idempotency_replays_total', { channel: 'http' })).toBe(1);
      expect(
        metrics.counter('wager_transactions_total', {
          status: 'PROCESSED',
          kind: 'BET',
          channel: 'http',
          failure_code: 'none',
        }),
      ).toBe(0);
      expect(metrics.observations('wallet_lock_wait_seconds', { channel: 'http' })).toHaveLength(0);
      expect(uow.database.transactions.rows()).toHaveLength(0);
      expect(uow.database.wallets.get('wallet-1')?.version).toBe(4);
    });

    it('replays through the inbox when another delivery committed the same message', async () => {
      const { uow, metrics, useCase } = harness();
      const command = sqsCommand();
      uow.interceptNextCommit(() => {
        const message = InboxMessage.receive({
          consumerName: SUBMISSION_CONSUMER,
          messageId: 'message-1',
          payloadHash: 'inbox-hash-1',
          now,
        });
        message.markProcessed(now);
        uow.database.inbox.put(message.toState());
        uow.database.idempotency.put(recordFor(command, competitorBody()).toState());
        return Promise.resolve();
      });

      const result = await useCase.execute(command);

      expect(result.kind === 'outcome' && result.replay).toBe(true);
      expect(metrics.counter('lock_conflicts_total', { type: 'unique_retry' })).toBe(1);
      expect(metrics.counter('inbox_duplicates_total', { consumer: SUBMISSION_CONSUMER })).toBe(1);
      expect(uow.database.transactions.rows()).toHaveLength(0);
    });

    it('turns a repeated race into a transient race_repeated error', async () => {
      const { uow, metrics, useCase } = harness();
      uow.interceptNextCommit(() => {
        uow.database.transactions.put(
          storedTransaction({
            id: 'tx-competitor',
            externalTransactionId: 'ext-competitor',
            idempotencyKey: 'key-1',
          }),
        );
        return Promise.resolve();
      });

      const error = await captureError(() => useCase.execute(httpCommand()));

      expect(error).toBeInstanceOf(TechnicalError);
      if (error instanceof TechnicalError) {
        expect(error.errorClass).toBe(ErrorClass.Transient);
        expect(error.reason).toBe('race_repeated');
      }
      expect(metrics.counter('lock_conflicts_total', { type: 'unique_retry' })).toBe(1);
      expect(uow.database.transactions.rows()).toHaveLength(1);
      expect(uow.database.idempotency.rows()).toHaveLength(0);
      expect(uow.database.walletEntries.rows()).toHaveLength(0);
      expect(uow.database.wallets.get('wallet-1')?.version).toBe(4);
    });

    it('lets errors that are not races go up untouched', async () => {
      const { uow, metrics, useCase } = harness();
      uow.database.houseAccounts.put({
        id: 'gaming-brl',
        currency: toCurrencyCode('USD'),
        purpose: HouseAccountPurpose.Gaming,
        createdAt: now,
      });

      const error = await captureError(() => useCase.execute(httpCommand()));

      expect(error).toBeInstanceOf(TechnicalError);
      if (error instanceof TechnicalError) {
        expect(error.errorClass).toBe(ErrorClass.Deterministic);
      }
      expect(metrics.counter('lock_conflicts_total', { type: 'unique_retry' })).toBe(0);
      expectNothingPersisted(uow);
    });
  });
});
