import { describe, expect, it } from 'bun:test';
import type { SubmitWagerTransactionCommand } from '@application/commands/submit-wager-transaction.command';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import { TRUSTED_CHANNEL } from '@application/ports/provider-identity.port';
import { OutcomeMapper } from '@application/services/outcome-mapper';
import { computePayloadHash } from '@application/services/payload-hash';
import { SUBMISSION_CONSUMER } from '@application/services/submission-fast-path';
import { MarkTransactionFailedUseCase } from '@application/use-cases/mark-transaction-failed.use-case';
import { IdempotencyRecord } from '@domain/idempotency/idempotency-record';
import type { TransactionResultBody } from '@domain/idempotency/response-bodies';
import { InboxMessage } from '@domain/messaging/inbox-message';
import { toCurrencyCode } from '@domain/shared/currency';
import { FailureAction, FailureCode } from '@domain/shared/failure-code';
import { Money } from '@domain/shared/money';
import type { WagerTransactionState } from '@domain/wagering/wager-transaction';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '@domain/wagering/wager-transaction-status';
import { Sha256Hasher } from '@infrastructure/system/sha256-hasher';
import { InMemoryUnitOfWork } from '@test/support/fakes/in-memory-unit-of-work.fake';
import { FakeLogger } from '@test/support/fakes/logger.fake';
import { FakeMetrics } from '@test/support/fakes/metrics.fake';
import { FakeTracer } from '@test/support/fakes/tracer.fake';
import { FixedClock } from '@test/support/fixed-clock';
import { SequentialIds } from '@test/support/sequential-ids';

const now = new Date('2026-03-01T12:00:00.000Z');
const hasher = new Sha256Hasher();
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

type EnrichedFields = Parameters<
  ConstructorParameters<typeof MarkTransactionFailedUseCase>[0]['enrich']
>[0];

interface Harness {
  readonly uow: InMemoryUnitOfWork;
  readonly metrics: FakeMetrics;
  readonly tracer: FakeTracer;
  readonly enriched: EnrichedFields[];
  readonly useCase: MarkTransactionFailedUseCase;
}

const harness = (): Harness => {
  const clock = new FixedClock(now);
  const uow = new InMemoryUnitOfWork(clock);
  const metrics = new FakeMetrics();
  const tracer = new FakeTracer();
  const enriched: EnrichedFields[] = [];
  const useCase = new MarkTransactionFailedUseCase({
    uow,
    clock,
    ids: new SequentialIds(),
    hasher,
    logger: new FakeLogger(),
    metrics,
    tracer,
    enrich: (fields) => {
      enriched.push(fields);
    },
    outcomeMapper: new OutcomeMapper(),
  });
  uow.database.wallets.put({
    id: 'wallet-1',
    playerId: 'player-1',
    currency: toCurrencyCode('BRL'),
    balance: brl('100.00'),
    version: 4,
    createdAt: now,
    updatedAt: now,
  });
  return { uow, metrics, tracer, enriched, useCase };
};

const sqsCommand = (
  overrides: Partial<SubmitWagerTransactionCommand> = {},
): SubmitWagerTransactionCommand => ({
  channel: 'sqs',
  identity: TRUSTED_CHANNEL,
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
  inbox: { messageId: 'message-1', payloadHash: 'inbox-hash-1' },
  ...overrides,
});

const competitorBody = (): TransactionResultBody => ({
  transactionId: 'tx-competitor',
  status: 'PROCESSED',
  kind: WagerTransactionKind.Bet,
  balance: { amount: '90.00', currency: 'BRL' },
  idempotentReplay: false,
});

const recordFor = (
  command: SubmitWagerTransactionCommand,
  payloadHash: string,
): IdempotencyRecord =>
  IdempotencyRecord.create({
    providerId: command.providerId,
    idempotencyKey: command.idempotencyKey,
    payloadHash,
    transactionId: 'tx-competitor',
    httpStatus: 200,
    responseBody: competitorBody(),
    createdAt: now,
  });

const storedTransaction = (overrides: Partial<WagerTransactionState>): WagerTransactionState => ({
  id: 'tx-competitor',
  providerId: 'provider-1',
  externalTransactionId: 'ext-1',
  idempotencyKey: 'key-other',
  payloadHash: 'hash-other',
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
  balanceSnapshot: brl('90.00'),
  correlationId: 'correlation-other',
  createdAt: now,
  processedAt: now,
  updatedAt: now,
  ...overrides,
});

const processedInbox = (payloadHash: string): InboxMessage => {
  const message = InboxMessage.receive({
    consumerName: SUBMISSION_CONSUMER,
    messageId: 'message-1',
    payloadHash,
    now,
  });
  message.markProcessed(now);
  return message;
};

const captureError = async (action: () => Promise<unknown>): Promise<unknown> => {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return undefined;
};

const failedTransactions = (uow: InMemoryUnitOfWork): WagerTransactionState[] =>
  uow.database.transactions.rows().filter((row) => row.status === WagerTransactionStatus.Failed);

describe('MarkTransactionFailedUseCase', () => {
  describe('normal path', () => {
    it('stores a FAILED transaction, a 500 record, the Failed event and the inbox', async () => {
      const { uow, metrics, useCase } = harness();
      const command = sqsCommand();

      const result = await useCase.execute(command);

      const [transaction] = uow.database.transactions.rows();
      expect(result).toEqual({
        kind: 'outcome',
        httpStatus: 500,
        body: {
          transactionId: transaction?.id ?? 'missing',
          status: 'FAILED',
          kind: WagerTransactionKind.Bet,
          failureCode: FailureCode.ProcessingFailed,
          retryable: false,
          action: FailureAction.GiveUp,
          balance: { amount: '100.00', currency: 'BRL' },
          idempotentReplay: false,
        },
        replay: false,
      });
      if (result.kind !== 'outcome') {
        return;
      }
      expect(uow.database.transactions.rows()).toHaveLength(1);
      expect(transaction?.status).toBe(WagerTransactionStatus.Failed);
      expect(transaction?.failureCode).toBe(FailureCode.ProcessingFailed);
      expect(transaction?.balanceSnapshot?.equals(brl('100.00'))).toBe(true);
      expect(transaction?.payloadHash).toBe(computePayloadHash(command, hasher));

      const [record] = uow.database.idempotency.rows();
      expect(uow.database.idempotency.rows()).toHaveLength(1);
      expect(record?.httpStatus).toBe(500);
      expect(record?.transactionId).toBe(transaction?.id);
      expect(record?.responseBody).toEqual(result.body);

      const outbox = uow.database.outbox.rows();
      expect(outbox.map((row) => row.eventType)).toEqual(['WagerTransactionFailed']);
      expect(outbox[0]?.payload).toMatchObject({
        correlationId: 'correlation-1',
        causationId: 'causation-1',
        data: {
          transactionId: transaction?.id,
          walletId: 'wallet-1',
          failureCode: 'PROCESSING_FAILED',
          walletVersion: 4,
        },
      });

      const [inbox] = uow.database.inbox.rows();
      expect(inbox?.consumerName).toBe(SUBMISSION_CONSUMER);
      expect(inbox?.processedAt).toEqual(now);

      expect(uow.database.walletEntries.rows()).toHaveLength(0);
      expect(uow.database.houseEntries.rows()).toHaveLength(0);
      expect(uow.database.wallets.get('wallet-1')?.version).toBe(4);
      expect(
        metrics.counter('wager_transactions_total', {
          status: 'FAILED',
          kind: 'BET',
          channel: 'sqs',
          failure_code: 'PROCESSING_FAILED',
        }),
      ).toBe(1);
      expect(
        metrics.observations('wager_processing_duration_seconds', {
          channel: 'sqs',
          status: 'FAILED',
        }),
      ).toHaveLength(1);
      expect(metrics.observations('wallet_lock_wait_seconds', { channel: 'sqs' })).toHaveLength(1);
    });

    it('enriches the context and runs inside its own span', async () => {
      const { tracer, enriched, uow, useCase } = harness();

      await useCase.execute(sqsCommand());

      const transactionId = uow.database.transactions.rows()[0]?.id;
      expect(enriched).toEqual([
        { walletId: 'wallet-1', providerId: 'provider-1' },
        { transactionId: transactionId ?? 'missing' },
      ]);
      expect(tracer.spans.map((span) => span.name)).toEqual(['usecase.mark_transaction_failed']);
    });

    it('replays the stored 500 on a later delivery of the same message', async () => {
      const { uow, useCase } = harness();
      const command = sqsCommand();
      await useCase.execute(command);

      const replayed = await useCase.execute(command);

      expect(replayed.kind === 'outcome' && replayed.replay).toBe(true);
      expect(replayed.kind === 'outcome' && replayed.httpStatus).toBe(500);
      expect(failedTransactions(uow)).toHaveLength(1);
      expect(uow.database.outbox.rows()).toHaveLength(1);
    });
  });

  describe('outcome already recorded', () => {
    it('replays the stored outcome without writing FAILED', async () => {
      const { uow, metrics, useCase } = harness();
      const command = sqsCommand();
      uow.database.idempotency.put(
        recordFor(command, computePayloadHash(command, hasher)).toState(),
      );

      const result = await useCase.execute(command);

      expect(result).toEqual({
        kind: 'outcome',
        httpStatus: 200,
        body: { ...competitorBody(), idempotentReplay: true },
        replay: true,
      });
      expect(uow.database.transactions.rows()).toHaveLength(0);
      expect(uow.database.outbox.rows()).toHaveLength(0);
      expect(uow.database.idempotency.rows()).toHaveLength(1);
      expect(uow.database.inbox.rows()[0]?.processedAt).toEqual(now);
      expect(metrics.counter('idempotency_replays_total', { channel: 'sqs' })).toBe(1);
    });

    it('answers idempotency-key-conflict and rolls back the inbox', async () => {
      const { uow, metrics, useCase } = harness();
      const command = sqsCommand();
      uow.database.idempotency.put(recordFor(command, 'another-hash').toState());

      const result = await useCase.execute(command);

      expect(result.kind).toBe('idempotency-key-conflict');
      expect(uow.database.transactions.rows()).toHaveLength(0);
      expect(uow.database.inbox.rows()).toHaveLength(0);
      expect(
        metrics.counter('idempotency_conflicts_total', {
          channel: 'sqs',
          type: 'idempotency_key',
        }),
      ).toBe(1);
    });

    it('records a 409 when another key already used the external transaction id', async () => {
      const { uow, metrics, useCase } = harness();
      uow.database.transactions.put(storedTransaction({}));

      const result = await useCase.execute(sqsCommand());

      expect(result.kind).toBe('external-id-conflict');
      if (result.kind === 'external-id-conflict') {
        expect(result.replay).toBe(false);
        expect(result.body.transactionId).toBe('tx-competitor');
        expect(result.body.failureCode).toBe(FailureCode.ExternalTransactionIdConflict);
      }
      expect(failedTransactions(uow)).toHaveLength(0);
      expect(uow.database.outbox.rows()).toHaveLength(0);
      expect(uow.database.idempotency.rows()[0]?.httpStatus).toBe(409);
      expect(uow.database.inbox.rows()[0]?.processedAt).toEqual(now);
      expect(
        metrics.counter('idempotency_conflicts_total', {
          channel: 'sqs',
          type: 'external_transaction_id',
        }),
      ).toBe(1);
    });
  });

  describe('wallet not found', () => {
    it('records a 422 WALLET_NOT_FOUND without a transaction or event', async () => {
      const { uow, metrics, useCase } = harness();

      const result = await useCase.execute(sqsCommand({ walletId: 'wallet-missing' }));

      expect(result).toEqual({
        kind: 'outcome',
        httpStatus: 422,
        body: {
          transactionId: null,
          status: 'REJECTED',
          kind: WagerTransactionKind.Bet,
          failureCode: FailureCode.WalletNotFound,
          retryable: false,
          action: FailureAction.GiveUp,
          balance: null,
          idempotentReplay: false,
        },
        replay: false,
      });
      expect(uow.database.transactions.rows()).toHaveLength(0);
      expect(uow.database.outbox.rows()).toHaveLength(0);
      const [record] = uow.database.idempotency.rows();
      expect(record?.httpStatus).toBe(422);
      expect(record?.transactionId).toBeUndefined();
      expect(uow.database.inbox.rows()[0]?.processedAt).toEqual(now);
      expect(
        metrics.counter('wager_transactions_total', {
          status: 'REJECTED',
          kind: 'BET',
          channel: 'sqs',
          failure_code: 'WALLET_NOT_FOUND',
        }),
      ).toBe(1);
    });
  });

  describe('race', () => {
    it('lets a new fast path replay when the inbox already holds the message', async () => {
      const { uow, metrics, useCase } = harness();
      const command = sqsCommand();
      uow.database.inbox.put(processedInbox('inbox-hash-1').toState());
      uow.database.idempotency.put(
        recordFor(command, computePayloadHash(command, hasher)).toState(),
      );

      const result = await useCase.execute(command);

      expect(result.kind === 'outcome' && result.replay).toBe(true);
      expect(failedTransactions(uow)).toHaveLength(0);
      expect(metrics.counter('lock_conflicts_total', { type: 'unique_retry' })).toBe(1);
      expect(metrics.counter('inbox_duplicates_total', { consumer: SUBMISSION_CONSUMER })).toBe(1);
      expect(metrics.counter('idempotency_replays_total', { channel: 'sqs' })).toBe(1);
    });

    it('lets a new fast path replay when a competing outcome commits first', async () => {
      const { uow, metrics, useCase } = harness();
      const command = sqsCommand();
      uow.interceptNextCommit(() => {
        uow.database.inbox.put(processedInbox('inbox-hash-1').toState());
        uow.database.idempotency.put(
          recordFor(command, computePayloadHash(command, hasher)).toState(),
        );
        return Promise.resolve();
      });

      const result = await useCase.execute(command);

      expect(result).toEqual({
        kind: 'outcome',
        httpStatus: 200,
        body: { ...competitorBody(), idempotentReplay: true },
        replay: true,
      });
      expect(uow.database.transactions.rows()).toHaveLength(0);
      expect(uow.database.outbox.rows()).toHaveLength(0);
      expect(
        metrics.counter('wager_transactions_total', {
          status: 'FAILED',
          kind: 'BET',
          channel: 'sqs',
          failure_code: 'PROCESSING_FAILED',
        }),
      ).toBe(0);
    });

    it('lets a new fast path answer the conflict when the key was taken with another payload', async () => {
      const { uow, metrics, useCase } = harness();
      const command = sqsCommand();
      uow.interceptNextCommit(() => {
        uow.database.idempotency.put(recordFor(command, 'another-hash').toState());
        return Promise.resolve();
      });

      const result = await useCase.execute(command);

      expect(result.kind).toBe('idempotency-key-conflict');
      expect(uow.database.transactions.rows()).toHaveLength(0);
      expect(uow.database.inbox.rows()).toHaveLength(0);
      expect(
        metrics.counter('idempotency_conflicts_total', {
          channel: 'sqs',
          type: 'idempotency_key',
        }),
      ).toBe(1);
    });

    it('runs once more when the fast path finds no record and then records the 409', async () => {
      const { uow, metrics, useCase } = harness();
      uow.interceptNextCommit(() => {
        uow.database.transactions.put(storedTransaction({}));
        return Promise.resolve();
      });

      const result = await useCase.execute(sqsCommand());

      expect(result.kind === 'external-id-conflict' && !result.replay).toBe(true);
      expect(failedTransactions(uow)).toHaveLength(0);
      expect(uow.database.idempotency.rows()[0]?.httpStatus).toBe(409);
      expect(metrics.counter('lock_conflicts_total', { type: 'unique_retry' })).toBe(1);
    });

    it('turns a repeated race into a transient race_repeated error', async () => {
      const { uow, useCase } = harness();
      uow.interceptNextCommit(() => {
        uow.database.transactions.put(
          storedTransaction({ externalTransactionId: 'ext-competitor', idempotencyKey: 'key-1' }),
        );
        return Promise.resolve();
      });

      const error = await captureError(() => useCase.execute(sqsCommand()));

      expect(error).toBeInstanceOf(TechnicalError);
      if (error instanceof TechnicalError) {
        expect(error.errorClass).toBe(ErrorClass.Transient);
        expect(error.reason).toBe('race_repeated');
      }
      expect(failedTransactions(uow)).toHaveLength(0);
      expect(uow.database.idempotency.rows()).toHaveLength(0);
      expect(uow.database.inbox.rows()).toHaveLength(0);
    });

    it('lets errors that are not races go up without writing anything', async () => {
      const { uow, metrics, useCase } = harness();

      const error = await captureError(() => useCase.execute(sqsCommand({ inbox: undefined })));

      expect(error).toBeInstanceOf(TechnicalError);
      if (error instanceof TechnicalError) {
        expect(error.errorClass).toBe(ErrorClass.Deterministic);
      }
      expect(metrics.counter('lock_conflicts_total', { type: 'unique_retry' })).toBe(0);
      expect(uow.database.transactions.rows()).toHaveLength(0);
      expect(uow.database.idempotency.rows()).toHaveLength(0);
      expect(uow.database.inbox.rows()).toHaveLength(0);
    });
  });
});
