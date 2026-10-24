import { describe, expect, it } from 'bun:test';
import type { Message } from '@aws-sdk/client-sqs';
import type {
  SubmitResult,
  SubmitWagerTransactionCommand,
} from '@application/commands/submit-wager-transaction.command';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import { ForbiddenError } from '@application/errors/forbidden.error';
import { NotFoundError } from '@application/errors/not-found.error';
import { UnauthenticatedError } from '@application/errors/unauthenticated.error';
import { WalletAlreadyExistsError } from '@application/errors/wallet-already-exists.error';
import type { ProblemBody, TransactionResultBody } from '@domain/idempotency/response-bodies';
import { FailureAction, FailureCode } from '@domain/shared/failure-code';
import { InvalidPayloadError } from '@domain/wagering/errors/invalid-payload.error';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { InsufficientFundsError } from '@domain/wallet/errors/insufficient-funds.error';
import { requestContext } from '@infrastructure/observability/request-context';
import type { RequestContext } from '@infrastructure/observability/request-context';
import { Sha256Hasher } from '@infrastructure/system/sha256-hasher';
import type { BreakerProbe } from '@interfaces/sqs/circuit-breaker';
import { DlqReason } from '@interfaces/sqs/dlq-mover';
import {
  MessageProcessor,
  backoffSecondsFor,
  receiveCountOf,
} from '@interfaces/sqs/message-processor';
import type { MessageAction } from '@interfaces/sqs/message-processor';
import { FakeLogger } from '@test/support/fakes/logger.fake';
import { FakeMetrics } from '@test/support/fakes/metrics.fake';

const MAX_RECEIVE_COUNT = 3;
const MESSAGE_ID = 'provider-a:message-1';
const V4_INBOX_HASH = 'a0b23737e20f6776c26497494deed2206e9418b3fd3a9dc43203c34866b05244';

type Submission = (command: SubmitWagerTransactionCommand) => Promise<SubmitResult>;

const v1Data = (): Record<string, unknown> => ({
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  idempotencyKey: 'provider-a:transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
});

const envelopeBody = (data: Record<string, unknown> = v1Data()): string =>
  JSON.stringify({
    messageId: MESSAGE_ID,
    type: 'WagerTransactionRequested',
    occurredAt: '2026-03-01T12:00:00.000Z',
    data,
  });

const sqsMessage = (
  options: { body?: string; receiveCount?: string; correlationId?: string } = {},
): Message => ({
  MessageId: 'sqs-message-id',
  ReceiptHandle: 'receipt-handle',
  Body: options.body ?? envelopeBody(),
  Attributes: {
    ApproximateReceiveCount: options.receiveCount ?? '1',
    MessageGroupId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  },
  ...(options.correlationId === undefined
    ? {}
    : {
        MessageAttributes: {
          correlationId: { DataType: 'String', StringValue: options.correlationId },
        },
      }),
});

const resultBody = (
  status: TransactionResultBody['status'],
  failureCode?: FailureCode,
): TransactionResultBody => ({
  transactionId: '00000000-0000-7000-8000-000000000001',
  status,
  kind: WagerTransactionKind.Bet,
  ...(failureCode === undefined ? {} : { failureCode }),
  balance: { amount: '75.00', currency: 'BRL' },
  idempotentReplay: false,
});

const problem = (failureCode: FailureCode): ProblemBody => ({
  type: 'about:blank',
  title: 'conflict',
  status: 409,
  detail: 'conflict',
  failureCode,
  retryable: false,
  action: FailureAction.GiveUp,
});

const outcome = (
  httpStatus: 200 | 202 | 422 | 500,
  replay: boolean,
  failureCode?: FailureCode,
): SubmitResult => ({
  kind: 'outcome',
  httpStatus,
  body: resultBody(httpStatus === 500 ? 'FAILED' : 'PROCESSED', failureCode),
  replay,
});

const resolving =
  (result: SubmitResult): Submission =>
  () =>
    Promise.resolve(result);

const failing =
  (error: Error): Submission =>
  () =>
    Promise.reject(error);

const never: Submission = () => {
  const pending: PromiseWithResolvers<SubmitResult> = Promise.withResolvers();
  return pending.promise;
};

interface Harness {
  readonly processor: MessageProcessor;
  readonly metrics: FakeMetrics;
  readonly logger: FakeLogger;
  readonly submitted: SubmitWagerTransactionCommand[];
  readonly failedPath: SubmitWagerTransactionCommand[];
  readonly openedProbes: BreakerProbe[];
  readonly contexts: Partial<RequestContext>[];
}

const harness = (
  options: { submit?: Submission; markFailed?: Submission; processingTimeoutMs?: number } = {},
): Harness => {
  const metrics = new FakeMetrics();
  const logger = new FakeLogger();
  const submitted: SubmitWagerTransactionCommand[] = [];
  const failedPath: SubmitWagerTransactionCommand[] = [];
  const openedProbes: BreakerProbe[] = [];
  const contexts: Partial<RequestContext>[] = [];
  const submit = options.submit ?? resolving(outcome(200, false));
  const markFailed =
    options.markFailed ?? resolving(outcome(500, false, FailureCode.ProcessingFailed));
  const processor = new MessageProcessor(
    {
      submit: {
        execute: (command) => {
          submitted.push(command);
          contexts.push(requestContext.current());
          return submit(command);
        },
      },
      markFailed: {
        execute: (command) => {
          failedPath.push(command);
          return markFailed(command);
        },
      },
      hasher: new Sha256Hasher(),
      breaker: {
        open: (probe) => {
          openedProbes.push(probe);
        },
      },
      metrics,
      logger,
    },
    {
      supportedCurrencies: ['BRL'],
      maxReceiveCount: MAX_RECEIVE_COUNT,
      processingTimeoutMs: options.processingTimeoutMs ?? 1_000,
    },
  );
  return { processor, metrics, logger, submitted, failedPath, openedProbes, contexts };
};

const dlqAction = (
  reason: DlqReason,
  failureCode: FailureCode | undefined,
  backoffSeconds = 4,
): MessageAction => ({ kind: 'dlq', reason, failureCode, backoffSeconds });

describe('MessageProcessor command', () => {
  it('builds the sqs command from the envelope with the inbox hash of the data', async () => {
    const h = harness();

    await h.processor.process(sqsMessage());

    expect(h.submitted).toEqual([
      {
        channel: 'sqs',
        identity: { kind: 'trusted-channel' },
        providerId: 'provider-a',
        externalTransactionId: 'transaction-123',
        idempotencyKey: 'provider-a:transaction-123',
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
        walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: undefined,
        correlationId: MESSAGE_ID,
        causationId: MESSAGE_ID,
        inbox: { messageId: MESSAGE_ID, payloadHash: V4_INBOX_HASH },
      },
    ]);
  });

  it('takes the correlation id from the message attribute when present', async () => {
    const h = harness();

    await h.processor.process(sqsMessage({ correlationId: 'correlation-1' }));

    expect(h.submitted[0]?.correlationId).toBe('correlation-1');
    expect(h.submitted[0]?.causationId).toBe(MESSAGE_ID);
  });

  it('keeps the reference of a reversal in the command', async () => {
    const h = harness();
    const data = {
      ...v1Data(),
      externalTransactionId: 'transaction-124',
      kind: 'REFUND',
      referenceExternalTransactionId: 'transaction-123',
    };

    await h.processor.process(sqsMessage({ body: envelopeBody(data) }));

    expect(h.submitted[0]?.kind).toBe(WagerTransactionKind.Refund);
    expect(h.submitted[0]?.referenceExternalTransactionId).toBe('transaction-123');
  });

  it('runs the use case inside the log context of the message', async () => {
    const h = harness();

    await h.processor.process(sqsMessage({ correlationId: 'correlation-1' }));

    expect(h.contexts[0]).toMatchObject({
      messageId: MESSAGE_ID,
      providerId: 'provider-a',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      correlationId: 'correlation-1',
    });
  });
});

describe('MessageProcessor backoff', () => {
  it('doubles the backoff per delivery up to 300 seconds', () => {
    expect(backoffSecondsFor(1)).toBe(4);
    expect(backoffSecondsFor(3)).toBe(16);
    expect(backoffSecondsFor(7)).toBe(256);
    expect(backoffSecondsFor(8)).toBe(300);
    expect(backoffSecondsFor(20)).toBe(300);
  });

  it('reads the approximate receive count and falls back to the first delivery', () => {
    expect(receiveCountOf(sqsMessage({ receiveCount: '5' }))).toBe(5);
    expect(receiveCountOf(sqsMessage({ receiveCount: 'not-a-number' }))).toBe(1);
    expect(receiveCountOf({ Body: '{}' })).toBe(1);
  });
});

describe('MessageProcessor results', () => {
  it.each([
    [200, false],
    [202, false],
    [422, false],
    [500, false],
    [200, true],
    [500, true],
  ] as const)('acks an outcome %d with replay %p', async (status, replay) => {
    const h = harness({ submit: resolving(outcome(status, replay)) });

    expect(await h.processor.process(sqsMessage())).toEqual({ kind: 'ack' });
    expect(h.failedPath).toHaveLength(0);
  });

  it('deletes a replayed external transaction id conflict', async () => {
    const h = harness({
      submit: resolving({
        kind: 'external-id-conflict',
        body: problem(FailureCode.ExternalTransactionIdConflict),
        replay: true,
      }),
    });

    expect(await h.processor.process(sqsMessage())).toEqual({ kind: 'delete' });
  });

  it('moves a new external transaction id conflict to the dlq', async () => {
    const h = harness({
      submit: resolving({
        kind: 'external-id-conflict',
        body: problem(FailureCode.ExternalTransactionIdConflict),
        replay: false,
      }),
    });

    expect(await h.processor.process(sqsMessage({ receiveCount: '2' }))).toEqual(
      dlqAction(
        DlqReason.ExternalTransactionIdConflict,
        FailureCode.ExternalTransactionIdConflict,
        8,
      ),
    );
  });

  it('moves an idempotency key conflict to the dlq', async () => {
    const h = harness({
      submit: resolving({
        kind: 'idempotency-key-conflict',
        body: problem(FailureCode.IdempotencyKeyConflict),
      }),
    });

    expect(await h.processor.process(sqsMessage())).toEqual(
      dlqAction(DlqReason.IdempotencyKeyConflict, FailureCode.IdempotencyKeyConflict),
    );
  });

  it('moves an inbox payload mismatch to the dlq', async () => {
    const h = harness({ submit: resolving({ kind: 'inbox-payload-mismatch' }) });

    expect(await h.processor.process(sqsMessage())).toEqual(
      dlqAction(DlqReason.InboxPayloadMismatch, undefined),
    );
  });

  it('does not emit retry or dlq metrics for resolved results', async () => {
    const h = harness({ submit: resolving({ kind: 'inbox-payload-mismatch' }) });

    await h.processor.process(sqsMessage());

    expect(h.metrics.counter('sqs_dlq_moved_total', { reason: 'INBOX_PAYLOAD_MISMATCH' })).toBe(0);
    expect(h.metrics.counter('sqs_retries_total', { reason: 'transient' })).toBe(0);
  });
});

describe('MessageProcessor invalid envelope', () => {
  const invalidBodies: readonly (readonly [string, string])[] = [
    ['a body that is not json', 'not json'],
    [
      'an envelope of another type',
      JSON.stringify({ ...JSON.parse(envelopeBody()), type: 'Other' }),
    ],
    [
      'an envelope with an unknown field',
      JSON.stringify({ ...JSON.parse(envelopeBody()), x: '1' }),
    ],
    ['an OPENING kind', envelopeBody({ ...v1Data(), kind: 'OPENING' })],
    ['the reserved system provider', envelopeBody({ ...v1Data(), providerId: '__system__' })],
    ['a provider id out of format', envelopeBody({ ...v1Data(), providerId: 'Provider A' })],
    [
      'a self reference',
      envelopeBody({
        ...v1Data(),
        kind: 'REFUND',
        referenceExternalTransactionId: 'transaction-123',
      }),
    ],
    [
      'an unsupported currency',
      envelopeBody({ ...v1Data(), money: { amount: '1.00', currency: 'USD' } }),
    ],
    ['a data without idempotency key', envelopeBody({ ...v1Data(), idempotencyKey: undefined })],
  ];

  it.each(invalidBodies)('moves %s to the dlq as INVALID_PAYLOAD', async (_label, body) => {
    const h = harness();

    expect(await h.processor.process(sqsMessage({ body }))).toEqual(
      dlqAction(DlqReason.InvalidPayload, undefined),
    );
    expect(h.submitted).toHaveLength(0);
  });

  it('moves a message without body to the dlq', async () => {
    const h = harness();

    expect(await h.processor.process({ MessageId: 'sqs-message-id' })).toEqual(
      dlqAction(DlqReason.InvalidPayload, undefined),
    );
  });
});

describe('MessageProcessor thrown errors', () => {
  it('moves a validation error to the dlq as INVALID_PAYLOAD with its failure code', async () => {
    const h = harness({ submit: failing(new InvalidPayloadError('self reference')) });

    expect(await h.processor.process(sqsMessage())).toEqual(
      dlqAction(DlqReason.InvalidPayload, FailureCode.InvalidPayload),
    );
  });

  it('deletes the message when a business error is thrown', async () => {
    const h = harness({ submit: failing(new InsufficientFundsError('balance too low')) });

    expect(await h.processor.process(sqsMessage())).toEqual({ kind: 'delete' });
    expect(h.metrics.counter('sqs_retries_total', { reason: 'deterministic' })).toBe(0);
  });

  it.each(['lock_timeout', 'version_mismatch'] as const)(
    'backs off a transient %s and counts a lock conflict',
    async (reason) => {
      const h = harness({ submit: failing(new TechnicalError(ErrorClass.Transient, reason)) });

      expect(await h.processor.process(sqsMessage({ receiveCount: '2' }))).toEqual({
        kind: 'backoff',
        backoffSeconds: 8,
      });
      expect(h.metrics.counter('sqs_retries_total', { reason: 'transient' })).toBe(1);
      expect(h.metrics.counter('lock_conflicts_total', { type: reason })).toBe(1);
      expect(h.openedProbes).toEqual([]);
    },
  );

  it('backs off other transient errors without a lock conflict', async () => {
    const h = harness({
      submit: failing(new TechnicalError(ErrorClass.Transient, 'serialization')),
    });

    expect(await h.processor.process(sqsMessage())).toEqual({ kind: 'backoff', backoffSeconds: 4 });
    expect(h.metrics.counter('sqs_retries_total', { reason: 'transient' })).toBe(1);
    expect(h.metrics.counter('lock_conflicts_total', { type: 'lock_timeout' })).toBe(0);
    expect(h.metrics.counter('lock_conflicts_total', { type: 'version_mismatch' })).toBe(0);
  });

  it.each(['database', 'queue'] as const)(
    'backs off a connectivity error and opens the breaker with the %s probe',
    async (probe) => {
      const h = harness({
        submit: failing(new TechnicalError(ErrorClass.Connectivity, 'connection', { probe })),
      });

      expect(await h.processor.process(sqsMessage())).toEqual({
        kind: 'backoff',
        backoffSeconds: 4,
      });
      expect(h.openedProbes).toEqual([probe]);
      expect(h.metrics.counter('sqs_retries_total', { reason: 'connectivity' })).toBe(1);
    },
  );

  it('opens the database probe when a connectivity error carries no probe', async () => {
    const h = harness({
      submit: failing(new TechnicalError(ErrorClass.Connectivity, 'connection')),
    });

    await h.processor.process(sqsMessage());

    expect(h.openedProbes).toEqual(['database']);
  });

  it('treats a use case slower than the processing timeout as a database connectivity error', async () => {
    const h = harness({ submit: never, processingTimeoutMs: 10 });

    expect(await h.processor.process(sqsMessage())).toEqual({ kind: 'backoff', backoffSeconds: 4 });
    expect(h.openedProbes).toEqual(['database']);
    expect(h.metrics.counter('sqs_retries_total', { reason: 'connectivity' })).toBe(1);
    expect(h.logger.entriesAt('warn').map((entry) => entry.fields)).toContainEqual({
      errorClass: ErrorClass.Connectivity,
      reason: 'processing_timeout',
      attempt: 1,
    });
  });

  it('backs off a deterministic error before the last delivery', async () => {
    const h = harness({
      submit: failing(new TechnicalError(ErrorClass.Deterministic, 'deterministic')),
    });

    expect(await h.processor.process(sqsMessage({ receiveCount: '2' }))).toEqual({
      kind: 'backoff',
      backoffSeconds: 8,
    });
    expect(h.metrics.counter('sqs_retries_total', { reason: 'deterministic' })).toBe(1);
    expect(h.failedPath).toHaveLength(0);
  });

  const otherClasses: readonly (readonly [string, Error])[] = [
    ['Permanent', new TechnicalError(ErrorClass.Permanent, 'queue_permanent')],
    ['Race', new TechnicalError(ErrorClass.Race, 'inbox')],
    ['NotFound', new NotFoundError()],
    ['Conflict', new WalletAlreadyExistsError('0192f291-27dd-7d3f-8071-5f8685deef37')],
    ['Authorization', new ForbiddenError()],
    ['Authentication', new UnauthenticatedError()],
    ['an unknown error', new RangeError('boom')],
  ];

  it.each(otherClasses)('treats %s as deterministic', async (_label, error) => {
    const h = harness({ submit: failing(error) });

    expect(await h.processor.process(sqsMessage())).toEqual({ kind: 'backoff', backoffSeconds: 4 });
    expect(h.metrics.counter('sqs_retries_total', { reason: 'deterministic' })).toBe(1);
  });
});

describe('MessageProcessor last delivery', () => {
  const lastDelivery = (): Message => sqsMessage({ receiveCount: String(MAX_RECEIVE_COUNT) });
  const deterministic = failing(new TechnicalError(ErrorClass.Deterministic, 'deterministic'));

  it('marks the transaction failed and moves a new FAILED to the dlq as PROCESSING_FAILED', async () => {
    const h = harness({ submit: deterministic });

    expect(await h.processor.process(lastDelivery())).toEqual(
      dlqAction(DlqReason.ProcessingFailed, FailureCode.ProcessingFailed, 16),
    );
    expect(h.failedPath).toEqual(h.submitted);
    expect(h.metrics.counter('sqs_retries_total', { reason: 'deterministic' })).toBe(0);
  });

  it('marks the transaction failed past the max receive count as well', async () => {
    const h = harness({ submit: deterministic });

    const action = await h.processor.process(sqsMessage({ receiveCount: '4' }));

    expect(action).toMatchObject({ kind: 'dlq', reason: DlqReason.ProcessingFailed });
  });

  it('treats an unknown error class at the last delivery as deterministic', async () => {
    const h = harness({ submit: failing(new ForbiddenError()) });

    const action = await h.processor.process(lastDelivery());

    expect(action).toMatchObject({ kind: 'dlq', reason: DlqReason.ProcessingFailed });
  });

  it('acks a redelivery whose FAILED was already recorded', async () => {
    const h = harness({
      submit: deterministic,
      markFailed: resolving(outcome(500, true, FailureCode.ProcessingFailed)),
    });

    expect(await h.processor.process(lastDelivery())).toEqual({ kind: 'ack' });
  });

  it('acks another outcome returned by the failed path', async () => {
    const h = harness({ submit: deterministic, markFailed: resolving(outcome(422, false)) });

    expect(await h.processor.process(lastDelivery())).toEqual({ kind: 'ack' });
  });

  it('handles a conflict returned by the failed path by its own row', async () => {
    const h = harness({
      submit: deterministic,
      markFailed: resolving({
        kind: 'idempotency-key-conflict',
        body: problem(FailureCode.IdempotencyKeyConflict),
      }),
    });

    expect(await h.processor.process(lastDelivery())).toEqual(
      dlqAction(DlqReason.IdempotencyKeyConflict, FailureCode.IdempotencyKeyConflict, 16),
    );
  });

  it('moves the message to the dlq as FAILED_PATH_ERROR when the failed path throws', async () => {
    const h = harness({
      submit: deterministic,
      markFailed: failing(new TechnicalError(ErrorClass.Transient, 'lock_timeout')),
    });

    expect(await h.processor.process(lastDelivery())).toEqual(
      dlqAction(DlqReason.FailedPathError, undefined, 16),
    );
    expect(h.logger.entriesAt('error').map((entry) => entry.fields)).toEqual([
      {
        errorClass: ErrorClass.Transient,
        reason: 'lock_timeout',
        dlqReason: DlqReason.FailedPathError,
        attempt: MAX_RECEIVE_COUNT,
      },
    ]);
    expect(h.metrics.counter('lock_conflicts_total', { type: 'lock_timeout' })).toBe(0);
  });

  it.each([
    ['transient', new TechnicalError(ErrorClass.Transient, 'lock_timeout')],
    [
      'connectivity',
      new TechnicalError(ErrorClass.Connectivity, 'connection', { probe: 'database' }),
    ],
  ] as const)(
    'backs off a %s error at the last delivery without recording anything',
    async (reason, error) => {
      const h = harness({ submit: failing(error) });

      expect(await h.processor.process(lastDelivery())).toEqual({
        kind: 'backoff',
        backoffSeconds: 16,
      });
      expect(h.failedPath).toHaveLength(0);
      expect(h.metrics.counter('sqs_retries_total', { reason })).toBe(1);
    },
  );
});
