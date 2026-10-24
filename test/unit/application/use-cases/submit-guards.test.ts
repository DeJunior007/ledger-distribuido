import { describe, expect, it } from 'bun:test';
import type {
  SubmitResult,
  SubmitWagerTransactionCommand,
} from '@application/commands/submit-wager-transaction.command';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import { ProviderIdentityMismatchError } from '@application/errors/provider-identity-mismatch.error';
import { TRUSTED_CHANNEL } from '@application/ports/provider-identity.port';
import { AnomalyDetector } from '@application/services/anomaly-detector';
import { OutcomeMapper } from '@application/services/outcome-mapper';
import { computePayloadHash } from '@application/services/payload-hash';
import { SUBMISSION_CONSUMER } from '@application/services/submission-fast-path';
import { SubmitWagerTransactionUseCase } from '@application/use-cases/submit-wager-transaction.use-case';
import { IdempotencyRecord } from '@domain/idempotency/idempotency-record';
import type { ProblemBody, TransactionResultBody } from '@domain/idempotency/response-bodies';
import { InboxMessage } from '@domain/messaging/inbox-message';
import { FailureAction, FailureCode } from '@domain/shared/failure-code';
import { Money } from '@domain/shared/money';
import { TransactionApplier } from '@domain/wagering/transaction-applier';
import { WagerTransaction } from '@domain/wagering/wager-transaction';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { Wallet } from '@domain/wallet/wallet';
import { Sha256Hasher } from '@infrastructure/system/sha256-hasher';
import { FakeFaultInjector } from '@test/support/fakes/fault-injector.fake';
import { InMemoryUnitOfWork } from '@test/support/fakes/in-memory-unit-of-work.fake';
import { FakeLogger } from '@test/support/fakes/logger.fake';
import { FakeMetrics } from '@test/support/fakes/metrics.fake';
import { FakeTracer } from '@test/support/fakes/tracer.fake';
import { FixedClock } from '@test/support/fixed-clock';
import { SequentialIds } from '@test/support/sequential-ids';

const now = new Date('2026-03-01T12:00:00.000Z');
const hasher = new Sha256Hasher();

type EnrichedFields = Parameters<
  ConstructorParameters<typeof SubmitWagerTransactionUseCase>[0]['enrich']
>[0];

interface Harness {
  readonly uow: InMemoryUnitOfWork;
  readonly metrics: FakeMetrics;
  readonly tracer: FakeTracer;
  readonly enriched: EnrichedFields[];
  readonly useCase: SubmitWagerTransactionUseCase;
}

const harness = (): Harness => {
  const clock = new FixedClock(now);
  const uow = new InMemoryUnitOfWork(clock);
  const metrics = new FakeMetrics();
  const tracer = new FakeTracer();
  const enriched: EnrichedFields[] = [];
  const useCase = new SubmitWagerTransactionUseCase(
    {
      uow,
      clock,
      ids: new SequentialIds(),
      hasher,
      faults: new FakeFaultInjector(),
      logger: new FakeLogger(),
      metrics,
      tracer,
      enrich: (fields) => {
        enriched.push(fields);
      },
      applier: TransactionApplier.create(),
      outcomeMapper: new OutcomeMapper(),
      anomalyDetector: new AnomalyDetector(),
    },
    { pendingTtlMs: 900_000 },
  );
  return { uow, metrics, tracer, enriched, useCase };
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

const outcomeBody = (): TransactionResultBody => ({
  transactionId: 'tx-stored',
  status: 'PROCESSED',
  kind: WagerTransactionKind.Bet,
  balance: { amount: '90.00', currency: 'BRL' },
  idempotentReplay: false,
});

const seedWallet = (uow: InMemoryUnitOfWork): void => {
  const { wallet } = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    openingTransactionId: 'wallet-1-opening',
    fundingAccountId: 'funding-brl',
    walletEntryId: 'wallet-1-entry-0',
    houseEntryId: 'wallet-1-house-entry-0',
    now,
  });
  uow.database.wallets.put({ ...wallet.toState(), version: 1 });
};

const recordFor = (
  command: SubmitWagerTransactionCommand,
  payloadHash: string,
  stored:
    { httpStatus: 200; body: TransactionResultBody } | { httpStatus: 409; body: ProblemBody } = {
    httpStatus: 200,
    body: outcomeBody(),
  },
): IdempotencyRecord =>
  IdempotencyRecord.create({
    providerId: command.providerId,
    idempotencyKey: command.idempotencyKey,
    payloadHash,
    transactionId: stored.httpStatus === 200 ? 'tx-stored' : undefined,
    httpStatus: stored.httpStatus,
    responseBody: stored.body,
    createdAt: now,
  });

const seedRecord = (
  uow: InMemoryUnitOfWork,
  command: SubmitWagerTransactionCommand,
  payloadHash: string,
): void => {
  uow.database.idempotency.put(recordFor(command, payloadHash).toState());
};

const existingTransaction = (idempotencyKey: string): WagerTransaction =>
  WagerTransaction.create({
    id: 'tx-existing',
    providerId: 'provider-1',
    externalTransactionId: 'ext-1',
    idempotencyKey,
    payloadHash: 'hash-existing',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '5.00', currency: 'BRL' }),
    referenceExternalTransactionId: undefined,
    correlationId: 'correlation-existing',
    now,
  });

const seedInbox = (uow: InMemoryUnitOfWork, payloadHash: string): void => {
  uow.database.inbox.put(
    InboxMessage.receive({
      consumerName: SUBMISSION_CONSUMER,
      messageId: 'message-1',
      payloadHash,
      now,
    }).toState(),
  );
};

const captureError = async (action: () => Promise<unknown>): Promise<unknown> => {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return undefined;
};

const expectTechnical = (
  error: unknown,
  errorClass: TechnicalError['errorClass'],
  reason: TechnicalError['reason'],
): void => {
  expect(error).toBeInstanceOf(TechnicalError);
  if (error instanceof TechnicalError) {
    expect(error.errorClass).toBe(errorClass);
    expect(error.reason).toBe(reason);
  }
};

const yieldToEventLoop = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

const whileWalletIsLocked = async (
  uow: InMemoryUnitOfWork,
  submit: () => Promise<SubmitResult>,
  writeWhileHolding: (repos: Parameters<Parameters<InMemoryUnitOfWork['run']>[1]>[0]) => void,
): Promise<SubmitResult> => {
  const held: PromiseWithResolvers<void> = Promise.withResolvers();
  const release: PromiseWithResolvers<void> = Promise.withResolvers();
  const holder = uow.run('write', async (repos) => {
    await repos.wallets.lockById('wallet-1');
    held.resolve();
    await release.promise;
    writeWhileHolding(repos);
  });
  await held.promise;
  const submission = submit();
  await yieldToEventLoop();
  release.resolve();
  await holder;
  return submission;
};

describe('SubmitWagerTransactionUseCase guards', () => {
  describe('step 0: identity', () => {
    it('throws on a provider identity mismatch before reading anything', async () => {
      const { uow, metrics, useCase } = harness();
      const command = httpCommand({
        identity: { kind: 'provider', providerId: 'provider-2', clientId: 'client-2' },
      });
      seedRecord(uow, command, 'another-hash');

      const error = await captureError(() => useCase.execute(command));

      expect(error).toBeInstanceOf(ProviderIdentityMismatchError);
      expect(
        metrics.counter('idempotency_conflicts_total', {
          channel: 'http',
          type: 'idempotency_key',
        }),
      ).toBe(0);
      expect(uow.database.idempotency.rows()).toHaveLength(1);
      expect(uow.database.inbox.rows()).toHaveLength(0);
    });

    it('enriches the context and runs inside the use case span', async () => {
      const { uow, tracer, enriched, useCase } = harness();
      const command = httpCommand();
      seedRecord(uow, command, computePayloadHash(command, hasher));

      await useCase.execute(command);

      expect(enriched).toContainEqual({ walletId: 'wallet-1', providerId: 'provider-1' });
      expect(tracer.spans.map((span) => span.name)).toContain('usecase.submit_wager_transaction');
    });

    it('accepts operator and trusted channel identities without matching the provider', async () => {
      const { uow, useCase } = harness();
      const operator = httpCommand({ identity: { kind: 'operator', clientId: 'ops' } });
      seedRecord(uow, operator, computePayloadHash(operator, hasher));

      const result = await useCase.execute(operator);

      expect(result.kind).toBe('outcome');
    });
  });

  describe('step 2: fast path', () => {
    it('replays a stored outcome without writing anything', async () => {
      const { uow, metrics, useCase } = harness();
      const command = httpCommand();
      seedRecord(uow, command, computePayloadHash(command, hasher));

      const result = await useCase.execute(command);

      expect(result).toEqual({
        kind: 'outcome',
        httpStatus: 200,
        body: { ...outcomeBody(), idempotentReplay: true },
        replay: true,
      });
      expect(metrics.counter('idempotency_replays_total', { channel: 'http' })).toBe(1);
      expect(uow.database.idempotency.rows()).toHaveLength(1);
      expect(uow.database.transactions.rows()).toHaveLength(0);
    });

    it('replays a stored 409 as an external id conflict', async () => {
      const { uow, useCase } = harness();
      uow.database.transactions.put(existingTransaction('key-other').toState());
      const command = httpCommand();
      const first = await useCase.execute(command);

      const replayed = await useCase.execute(command);

      expect(first.kind).toBe('external-id-conflict');
      expect(replayed.kind).toBe('external-id-conflict');
      if (replayed.kind === 'external-id-conflict') {
        expect(replayed.replay).toBe(true);
        expect(replayed.body.idempotentReplay).toBe(true);
        expect(replayed.body.transactionId).toBe('tx-existing');
      }
    });

    it('answers idempotency-key-conflict when the key was used with another payload', async () => {
      const { uow, metrics, useCase } = harness();
      const command = httpCommand();
      seedRecord(uow, command, 'another-hash');

      const result = await useCase.execute(command);

      expect(result).toEqual({
        kind: 'idempotency-key-conflict',
        body: {
          type: 'urn:jungle:problem:IDEMPOTENCY_KEY_CONFLICT',
          title: 'Idempotency key conflict',
          status: 409,
          detail: 'The idempotency key was already used with a different payload',
          failureCode: FailureCode.IdempotencyKeyConflict,
          retryable: false,
          action: FailureAction.FixPayload,
        },
      });
      expect(
        metrics.counter('idempotency_conflicts_total', {
          channel: 'http',
          type: 'idempotency_key',
        }),
      ).toBe(1);
      expect(uow.database.idempotency.rows()).toHaveLength(1);
    });
  });

  describe('step 1: inbox', () => {
    it('treats a duplicate delivery as a replay', async () => {
      const { uow, metrics, useCase } = harness();
      const command = sqsCommand();
      seedInbox(uow, 'inbox-hash-1');
      seedRecord(uow, command, computePayloadHash(command, hasher));

      const result = await useCase.execute(command);

      expect(result.kind).toBe('outcome');
      if (result.kind === 'outcome') {
        expect(result.replay).toBe(true);
      }
      expect(metrics.counter('inbox_duplicates_total', { consumer: SUBMISSION_CONSUMER })).toBe(1);
      expect(metrics.counter('idempotency_replays_total', { channel: 'sqs' })).toBe(1);
    });

    it('answers inbox-payload-mismatch when the same message carries another payload', async () => {
      const { uow, metrics, useCase } = harness();
      const command = sqsCommand();
      seedInbox(uow, 'another-inbox-hash');
      seedRecord(uow, command, computePayloadHash(command, hasher));

      const result = await useCase.execute(command);

      expect(result).toEqual({ kind: 'inbox-payload-mismatch' });
      expect(
        metrics.counter('inbox_payload_mismatch_total', { consumer: SUBMISSION_CONSUMER }),
      ).toBe(1);
      expect(metrics.counter('idempotency_replays_total', { channel: 'sqs' })).toBe(0);
      expect(uow.database.inbox.rows()[0]?.processedAt).toBeUndefined();
    });

    it('fails deterministically when a duplicate delivery has no idempotency record', async () => {
      const { uow, useCase } = harness();
      seedInbox(uow, 'inbox-hash-1');

      const error = await captureError(() => useCase.execute(sqsCommand()));

      expectTechnical(error, ErrorClass.Deterministic, 'inbox_without_record');
      expect(uow.database.idempotency.rows()).toHaveLength(0);
    });

    it('rejects an sqs command without inbox data as a programming error', async () => {
      const { uow, useCase } = harness();

      const error = await captureError(() => useCase.execute(sqsCommand({ inbox: undefined })));

      expectTechnical(error, ErrorClass.Deterministic, 'deterministic');
      expect(uow.database.inbox.rows()).toHaveLength(0);
    });
  });

  describe('steps 4.1 and 7: external transaction id already used', () => {
    it('records a 409 before touching the wallet when another key used the id', async () => {
      const { uow, metrics, useCase } = harness();
      uow.database.transactions.put(existingTransaction('key-other').toState());
      const command = sqsCommand({ walletId: 'wallet-missing' });

      const result = await useCase.execute(command);

      const body = {
        type: 'urn:jungle:problem:EXTERNAL_TRANSACTION_ID_CONFLICT',
        title: 'External transaction id conflict',
        status: 409,
        detail: 'The external transaction id was already used by another transaction',
        failureCode: FailureCode.ExternalTransactionIdConflict,
        retryable: false,
        action: FailureAction.FixPayload,
        transactionId: 'tx-existing',
        idempotentReplay: false,
      };
      expect(result).toEqual({ kind: 'external-id-conflict', body, replay: false });
      expect(uow.database.idempotency.rows()).toEqual([
        {
          providerId: 'provider-1',
          idempotencyKey: 'key-1',
          payloadHash: computePayloadHash(command, hasher),
          transactionId: undefined,
          httpStatus: 409,
          responseBody: body,
          createdAt: now,
          updatedAt: now,
        },
      ]);
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
        metrics.counter('idempotency_conflicts_total', {
          channel: 'sqs',
          type: 'external_transaction_id',
        }),
      ).toBe(1);
    });

    it('records a 409 when the id is taken while waiting for the wallet lock', async () => {
      const { uow, metrics, useCase } = harness();
      seedWallet(uow);
      const command = httpCommand();

      const result = await whileWalletIsLocked(
        uow,
        () => useCase.execute(command),
        (repos) => {
          repos.transactions.insert(existingTransaction('key-other'));
        },
      );

      expect(result.kind).toBe('external-id-conflict');
      if (result.kind === 'external-id-conflict') {
        expect(result.replay).toBe(false);
        expect(result.body.transactionId).toBe('tx-existing');
      }
      const records = uow.database.idempotency.rows();
      expect(records).toHaveLength(1);
      expect(records[0]?.httpStatus).toBe(409);
      expect(records[0]?.transactionId).toBeUndefined();
      expect(metrics.counter('lock_conflicts_total', { type: 'contended' })).toBe(1);
      expect(metrics.observations('wallet_lock_wait_seconds', { channel: 'http' })).toHaveLength(1);
    });
  });

  describe('step 5: wallet not found', () => {
    it('records a 422 WALLET_NOT_FOUND and marks the inbox', async () => {
      const { uow, metrics, useCase } = harness();
      const command = sqsCommand();

      const result = await useCase.execute(command);

      const body: TransactionResultBody = {
        transactionId: null,
        status: 'REJECTED',
        kind: WagerTransactionKind.Bet,
        failureCode: FailureCode.WalletNotFound,
        retryable: false,
        action: FailureAction.GiveUp,
        balance: null,
        idempotentReplay: false,
      };
      expect(result).toEqual({ kind: 'outcome', httpStatus: 422, body, replay: false });
      const records = uow.database.idempotency.rows();
      expect(records).toHaveLength(1);
      expect(records[0]?.httpStatus).toBe(422);
      expect(records[0]?.transactionId).toBeUndefined();
      expect(records[0]?.responseBody).toEqual(body);
      expect(uow.database.inbox.rows()[0]?.processedAt).toEqual(now);
      expect(uow.database.transactions.rows()).toHaveLength(0);
      expect(
        metrics.counter('wager_transactions_total', {
          status: 'REJECTED',
          kind: 'BET',
          channel: 'sqs',
          failure_code: 'WALLET_NOT_FOUND',
        }),
      ).toBe(1);
      expect(
        metrics.observations('wager_processing_duration_seconds', {
          channel: 'sqs',
          status: 'REJECTED',
        }),
      ).toHaveLength(1);
    });

    it('replays the stored WALLET_NOT_FOUND on the next attempt', async () => {
      const { useCase } = harness();
      await useCase.execute(httpCommand());

      const replayed = await useCase.execute(httpCommand());

      expect(replayed.kind).toBe('outcome');
      if (replayed.kind === 'outcome') {
        expect(replayed.httpStatus).toBe(422);
        expect(replayed.replay).toBe(true);
        expect(replayed.body.failureCode).toBe(FailureCode.WalletNotFound);
        expect(replayed.body.idempotentReplay).toBe(true);
      }
    });
  });

  describe('step 6: re-check under the wallet lock', () => {
    it('rolls back everything, inbox included, when the record diverges under the lock', async () => {
      const { uow, metrics, useCase } = harness();
      seedWallet(uow);
      const command = sqsCommand();
      const competing = recordFor(command, 'another-hash');

      const result = await whileWalletIsLocked(
        uow,
        () => useCase.execute(command),
        (repos) => {
          repos.idempotency.insert(competing);
        },
      );

      expect(result.kind).toBe('idempotency-key-conflict');
      if (result.kind === 'idempotency-key-conflict') {
        expect(result.body.failureCode).toBe(FailureCode.IdempotencyKeyConflict);
      }
      expect(uow.database.inbox.rows()).toHaveLength(0);
      expect(uow.database.idempotency.rows()).toEqual([competing.toState()]);
      expect(
        metrics.counter('idempotency_conflicts_total', {
          channel: 'sqs',
          type: 'idempotency_key',
        }),
      ).toBe(1);
    });

    it('replays and commits the inbox when the record matches under the lock', async () => {
      const { uow, metrics, useCase } = harness();
      seedWallet(uow);
      const command = sqsCommand();
      const competing = recordFor(command, computePayloadHash(command, hasher));

      const result = await whileWalletIsLocked(
        uow,
        () => useCase.execute(command),
        (repos) => {
          repos.idempotency.insert(competing);
        },
      );

      expect(result).toEqual({
        kind: 'outcome',
        httpStatus: 200,
        body: { ...outcomeBody(), idempotentReplay: true },
        replay: true,
      });
      expect(uow.database.inbox.rows()[0]?.processedAt).toEqual(now);
      expect(uow.database.idempotency.rows()).toEqual([competing.toState()]);
      expect(metrics.counter('idempotency_replays_total', { channel: 'sqs' })).toBe(1);
    });
  });
});
