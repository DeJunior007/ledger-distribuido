import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import type { QueryResultRow } from 'pg';
import type {
  SubmitResult,
  SubmitWagerTransactionCommand,
} from '@application/commands/submit-wager-transaction.command';
import { ProviderIdentityMismatchError } from '@application/errors/provider-identity-mismatch.error';
import { TRUSTED_CHANNEL } from '@application/ports/provider-identity.port';
import { AnomalyDetector } from '@application/services/anomaly-detector';
import { OutcomeMapper } from '@application/services/outcome-mapper';
import { CreateWalletUseCase } from '@application/use-cases/create-wallet.use-case';
import { SubmitWagerTransactionUseCase } from '@application/use-cases/submit-wager-transaction.use-case';
import { FailureAction, FailureCode } from '@domain/shared/failure-code';
import { InvalidPayloadError } from '@domain/wagering/errors/invalid-payload.error';
import { TransactionApplier } from '@domain/wagering/transaction-applier';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { loadConfig } from '@infrastructure/config/env.schema';
import { contextEnricher } from '@infrastructure/observability/context-enricher';
import { createLogger } from '@infrastructure/observability/logger';
import { createMetricsRegistry } from '@infrastructure/observability/metrics.registry';
import { PinoLoggerAdapter } from '@infrastructure/observability/pino-logger.adapter';
import { PromMetricsAdapter } from '@infrastructure/observability/prom-metrics.adapter';
import { MikroOrmUnitOfWork } from '@infrastructure/persistence/mikro-orm-unit-of-work';
import { closeOrmInstances, openOrmInstances } from '@infrastructure/persistence/orm-instances';
import type { OrmInstances } from '@infrastructure/persistence/orm-instances';
import { NoopFaultInjector } from '@infrastructure/system/noop-fault-injector';
import { NoopTracer } from '@infrastructure/system/noop-tracer';
import { Sha256Hasher } from '@infrastructure/system/sha256-hasher';
import { SystemClock } from '@infrastructure/system/system-clock';
import { Uuidv7IdGenerator } from '@infrastructure/system/uuidv7-id-generator';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { waitFor } from '@test/support/wait-for';

const PROVIDER = 'provider-wagering-submit';
const CURRENCY = 'BRL';
const LOCK_WAIT = { timeoutMs: 2_000, intervalMs: 10 } as const;

const clock = new SystemClock();
const ids = new Uuidv7IdGenerator();
const hasher = new Sha256Hasher();
const tracer = new NoopTracer();
const metrics = new PromMetricsAdapter(createMetricsRegistry().metrics);
const logger = new PinoLoggerAdapter(
  createLogger({ level: 'silent', service: 'wagering-submit', instanceId: 'wagering-submit' }),
);

class UnexpectedResultError extends Error {
  constructor(expected: string, actual: string) {
    super(`expected a ${expected} result, got ${actual}`);
    this.name = 'UnexpectedResultError';
  }
}

interface WalletFixture {
  readonly walletId: string;
  readonly playerId: string;
}

interface StoredTransaction {
  readonly id: string;
  readonly status: string;
  readonly failure_code: string | null;
  readonly reference_transaction_id: string | null;
}

interface StoredRecord {
  readonly http_status: number;
  readonly transaction_id: string | null;
  readonly response_body: Readonly<Record<string, unknown>>;
}

interface StoredWallet {
  readonly balance: string;
  readonly version: number;
}

interface StoredInbox {
  readonly processed: boolean;
}

interface TableCounts {
  readonly transactions: number;
  readonly entries: number;
  readonly records: number;
  readonly outbox: number;
  readonly inbox: number;
  readonly pending: number;
}

interface WalletLockHolder {
  release(): Promise<void>;
}

type OutcomeResult = Extract<SubmitResult, { kind: 'outcome' }>;

const outcomeOf = (result: SubmitResult): OutcomeResult => {
  if (result.kind !== 'outcome') {
    throw new UnexpectedResultError('outcome', result.kind);
  }
  return result;
};

const failureOf = <T>(promise: Promise<T>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );

const brl = (amount: string) => ({ amount, currency: CURRENCY });

describe('SubmitWagerTransactionUseCase on postgres', () => {
  let database: TestDatabase;
  let instances: OrmInstances | undefined;
  let uow: MikroOrmUnitOfWork;
  let useCase: SubmitWagerTransactionUseCase;

  const query = async <Row extends QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<Row[]> => {
    const client = new Client({ connectionString: database.superuserUrl });
    await client.connect();
    try {
      const result = await client.query<Row>(sql, params);
      return result.rows;
    } finally {
      await client.end();
    }
  };

  const openWallet = async (amount = '100.00'): Promise<WalletFixture> => {
    const createWallet = new CreateWalletUseCase({
      uow,
      clock,
      ids,
      hasher,
      logger,
      metrics,
      tracer,
      enrich: contextEnricher,
    });
    const view = await createWallet.execute({
      playerId: crypto.randomUUID(),
      initialBalance: brl(amount),
      correlationId: crypto.randomUUID(),
      causationId: crypto.randomUUID(),
    });
    return { walletId: view.id, playerId: view.playerId };
  };

  const commandFor = (
    wallet: WalletFixture,
    overrides: Partial<SubmitWagerTransactionCommand> = {},
  ): SubmitWagerTransactionCommand => ({
    channel: 'http',
    identity: { kind: 'provider', providerId: PROVIDER, clientId: 'client-wagering-submit' },
    providerId: PROVIDER,
    externalTransactionId: `ext-${crypto.randomUUID()}`,
    idempotencyKey: `key-${crypto.randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: brl('10.00'),
    referenceExternalTransactionId: undefined,
    correlationId: crypto.randomUUID(),
    causationId: crypto.randomUUID(),
    inbox: undefined,
    ...overrides,
  });

  const sqsCommandFor = (
    wallet: WalletFixture,
    overrides: Partial<SubmitWagerTransactionCommand> = {},
  ): SubmitWagerTransactionCommand => {
    const messageId = crypto.randomUUID();
    return commandFor(wallet, {
      channel: 'sqs',
      identity: TRUSTED_CHANNEL,
      inbox: { messageId, payloadHash: hasher.sha256Hex(messageId) },
      ...overrides,
    });
  };

  const transactionOf = async (
    externalTransactionId: string,
  ): Promise<StoredTransaction | undefined> => {
    const rows = await query<StoredTransaction>(
      `SELECT id, status, failure_code, reference_transaction_id
       FROM wager_transactions WHERE provider_id = $1 AND external_transaction_id = $2`,
      [PROVIDER, externalTransactionId],
    );
    return rows[0];
  };

  const recordOf = async (idempotencyKey: string): Promise<StoredRecord | undefined> => {
    const rows = await query<StoredRecord>(
      `SELECT http_status, transaction_id, response_body
       FROM idempotency_records WHERE provider_id = $1 AND idempotency_key = $2`,
      [PROVIDER, idempotencyKey],
    );
    return rows[0];
  };

  const walletOf = async (walletId: string): Promise<StoredWallet | undefined> => {
    const rows = await query<StoredWallet>(
      'SELECT balance::text AS balance, version FROM wallets WHERE id = $1',
      [walletId],
    );
    return rows[0];
  };

  const inboxOf = async (messageId: string): Promise<StoredInbox | undefined> => {
    const rows = await query<StoredInbox>(
      `SELECT processed_at IS NOT NULL AS processed FROM inbox_messages
       WHERE consumer_name = 'wager-transactions-consumer' AND message_id = $1`,
      [messageId],
    );
    return rows[0];
  };

  const entriesOf = async (transactionId: string): Promise<string[]> => {
    const rows = await query<{ account_kind: string; direction: string }>(
      `SELECT account_kind, direction FROM ledger_entries WHERE transaction_id = $1
       ORDER BY account_kind DESC`,
      [transactionId],
    );
    return rows.map((row) => `${row.account_kind}:${row.direction}`);
  };

  const eventsOf = async (transactionId: string): Promise<string[]> => {
    const rows = await query<{ event_type: string }>(
      'SELECT event_type FROM outbox_messages WHERE payload::text LIKE $1 ORDER BY event_type',
      [`%${transactionId}%`],
    );
    return rows.map((row) => row.event_type);
  };

  const counts = async (): Promise<TableCounts> => {
    const rows = await query<TableCounts>(
      `SELECT (SELECT count(*)::int FROM wager_transactions) AS transactions,
              (SELECT count(*)::int FROM ledger_entries) AS entries,
              (SELECT count(*)::int FROM idempotency_records) AS records,
              (SELECT count(*)::int FROM outbox_messages) AS outbox,
              (SELECT count(*)::int FROM inbox_messages) AS inbox,
              (SELECT count(*)::int FROM pending_reference_retries) AS pending`,
    );
    const [row] = rows;
    if (row === undefined) {
      throw new UnexpectedResultError('counts', 'nothing');
    }
    return row;
  };

  const lockWaiters = async (): Promise<number> => {
    const rows = await query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
       WHERE datname = $1 AND usename = 'jungle_app' AND wait_event_type = 'Lock'`,
      [database.name],
    );
    return rows[0]?.waiting ?? 0;
  };

  const holdWalletLock = async (walletId: string): Promise<WalletLockHolder> => {
    const client = new Client({ connectionString: database.superuserUrl });
    await client.connect();
    await client.query('BEGIN');
    await client.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [walletId]);
    let released = false;
    return {
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        try {
          await client.query('COMMIT');
        } finally {
          await client.end();
        }
      },
    };
  };

  const whileWalletIsLocked = async <T>(
    walletId: string,
    waiters: number,
    start: () => Promise<T>,
    meanwhile: () => Promise<void> = () => Promise.resolve(),
  ): Promise<T> => {
    const holder = await holdWalletLock(walletId);
    try {
      const pending = start();
      const settled = failureOf(pending);
      await waitFor(async () => (await lockWaiters()) >= waiters, LOCK_WAIT);
      await meanwhile();
      await holder.release();
      await settled;
      return await pending;
    } finally {
      await holder.release();
    }
  };

  beforeEach(async () => {
    database = await createTestDatabase();
    const config = loadConfig({ DATABASE_URL: database.appUrl }, { role: 'api' });
    instances = await openOrmInstances(config);
    uow = new MikroOrmUnitOfWork(instances, config);
    useCase = new SubmitWagerTransactionUseCase(
      {
        uow,
        clock,
        ids,
        hasher,
        faults: new NoopFaultInjector(),
        logger,
        metrics,
        tracer,
        enrich: contextEnricher,
        applier: TransactionApplier.create(),
        outcomeMapper: new OutcomeMapper(),
        anomalyDetector: new AnomalyDetector(),
      },
      { pendingTtlMs: config.PENDING_TTL_MS },
    );
  });

  afterEach(async () => {
    if (instances !== undefined) {
      await closeOrmInstances(instances);
      instances = undefined;
    }
  });

  describe('identity and validation', () => {
    it('throws on a provider identity mismatch and writes nothing', async () => {
      const wallet = await openWallet();
      const before = await counts();

      const failure = await failureOf(
        useCase.execute(
          commandFor(wallet, {
            identity: { kind: 'provider', providerId: 'someone-else', clientId: 'client-x' },
          }),
        ),
      );

      expect(failure).toBeInstanceOf(ProviderIdentityMismatchError);
      expect(await counts()).toEqual(before);
    });

    it('lets a domain validation error go up and writes nothing', async () => {
      const wallet = await openWallet();
      const before = await counts();
      const externalTransactionId = `ext-${crypto.randomUUID()}`;

      const failure = await failureOf(
        useCase.execute(
          commandFor(wallet, {
            kind: WagerTransactionKind.Win,
            externalTransactionId,
            referenceExternalTransactionId: externalTransactionId,
          }),
        ),
      );

      expect(failure).toBeInstanceOf(InvalidPayloadError);
      expect(await counts()).toEqual(before);
    });
  });

  describe('PROCESSED', () => {
    it('stores the transaction, posting, wallet version, events and record of a BET', async () => {
      const wallet = await openWallet();
      const command = commandFor(wallet);

      const result = outcomeOf(await useCase.execute(command));

      const stored = await transactionOf(command.externalTransactionId);
      expect(result).toEqual({
        kind: 'outcome',
        httpStatus: 200,
        replay: false,
        body: {
          transactionId: stored?.id ?? null,
          status: 'PROCESSED',
          kind: WagerTransactionKind.Bet,
          balance: brl('90.00'),
          idempotentReplay: false,
        },
      });
      expect(stored?.status).toBe('PROCESSED');
      expect(await walletOf(wallet.walletId)).toEqual({ balance: '90.00', version: 2 });
      expect(await entriesOf(result.body.transactionId ?? '')).toEqual([
        'WALLET:DEBIT',
        'HOUSE:CREDIT',
      ]);
      expect(await eventsOf(result.body.transactionId ?? '')).toEqual([
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
      const record = await recordOf(command.idempotencyKey);
      expect(record?.http_status).toBe(200);
      expect(record?.transaction_id).toBe(result.body.transactionId);
      expect(record?.response_body).toEqual({ ...result.body });
    });

    it('replays the stored outcome without writing anything else', async () => {
      const wallet = await openWallet();
      const command = commandFor(wallet);
      const first = outcomeOf(await useCase.execute(command));
      const before = await counts();

      const replay = await useCase.execute(command);

      expect(replay).toEqual({
        kind: 'outcome',
        httpStatus: 200,
        replay: true,
        body: { ...first.body, idempotentReplay: true },
      });
      expect(await counts()).toEqual(before);
      expect(await walletOf(wallet.walletId)).toEqual({ balance: '90.00', version: 2 });
    });

    it('stores a LOSS on a processed BET without a posting', async () => {
      const wallet = await openWallet();
      const bet = commandFor(wallet);
      await useCase.execute(bet);
      const loss = commandFor(wallet, {
        kind: WagerTransactionKind.Loss,
        money: brl('0.00'),
        referenceExternalTransactionId: bet.externalTransactionId,
      });

      const result = outcomeOf(await useCase.execute(loss));

      expect(result.httpStatus).toBe(200);
      expect(result.body.status).toBe('PROCESSED');
      expect(result.body.balance).toEqual(brl('90.00'));
      expect(await entriesOf(result.body.transactionId ?? '')).toEqual([]);
      expect(await eventsOf(result.body.transactionId ?? '')).toEqual([
        'WagerTransactionProcessed',
      ]);
      expect(await walletOf(wallet.walletId)).toEqual({ balance: '90.00', version: 2 });
    });

    it('credits a WIN that references a processed BET', async () => {
      const wallet = await openWallet();
      const bet = commandFor(wallet);
      const placed = outcomeOf(await useCase.execute(bet));

      const result = outcomeOf(
        await useCase.execute(
          commandFor(wallet, {
            kind: WagerTransactionKind.Win,
            money: brl('25.00'),
            referenceExternalTransactionId: bet.externalTransactionId,
          }),
        ),
      );

      expect(result.body.status).toBe('PROCESSED');
      expect(result.body.balance).toEqual(brl('115.00'));
      expect(await entriesOf(result.body.transactionId ?? '')).toEqual([
        'WALLET:CREDIT',
        'HOUSE:DEBIT',
      ]);
      const stored = await query<{ reference_transaction_id: string | null }>(
        'SELECT reference_transaction_id FROM wager_transactions WHERE id = $1',
        [result.body.transactionId],
      );
      expect(stored[0]?.reference_transaction_id).toBe(placed.body.transactionId);
    });
  });

  describe('REJECTED', () => {
    it('stores a rejection with its record and event when the balance is insufficient', async () => {
      const wallet = await openWallet('5.00');
      const command = commandFor(wallet, { money: brl('50.00') });

      const result = outcomeOf(await useCase.execute(command));

      expect(result).toEqual({
        kind: 'outcome',
        httpStatus: 422,
        replay: false,
        body: {
          transactionId: result.body.transactionId,
          status: 'REJECTED',
          kind: WagerTransactionKind.Bet,
          failureCode: FailureCode.InsufficientFunds,
          retryable: false,
          action: FailureAction.GiveUp,
          balance: brl('5.00'),
          idempotentReplay: false,
        },
      });
      const stored = await transactionOf(command.externalTransactionId);
      expect(stored?.status).toBe('REJECTED');
      expect(stored?.failure_code).toBe(FailureCode.InsufficientFunds);
      expect(await entriesOf(stored?.id ?? '')).toEqual([]);
      expect(await eventsOf(stored?.id ?? '')).toEqual(['WagerTransactionRejected']);
      expect((await recordOf(command.idempotencyKey))?.http_status).toBe(422);
      expect(await walletOf(wallet.walletId)).toEqual({ balance: '5.00', version: 1 });
    });

    it('rejects a player that does not own the wallet', async () => {
      const wallet = await openWallet();
      const command = commandFor(wallet, { playerId: crypto.randomUUID() });

      const result = outcomeOf(await useCase.execute(command));

      expect(result.httpStatus).toBe(422);
      expect(result.body.failureCode).toBe(FailureCode.PlayerWalletMismatch);
      expect((await transactionOf(command.externalTransactionId))?.status).toBe('REJECTED');
      expect(await walletOf(wallet.walletId)).toEqual({ balance: '100.00', version: 1 });
    });

    it('records WALLET_NOT_FOUND without a transaction and replays it', async () => {
      const command = commandFor({ walletId: crypto.randomUUID(), playerId: crypto.randomUUID() });

      const result = outcomeOf(await useCase.execute(command));

      expect(result.httpStatus).toBe(422);
      expect(result.body).toEqual({
        transactionId: null,
        status: 'REJECTED',
        kind: WagerTransactionKind.Bet,
        failureCode: FailureCode.WalletNotFound,
        retryable: false,
        action: FailureAction.GiveUp,
        balance: null,
        idempotentReplay: false,
      });
      expect(await transactionOf(command.externalTransactionId)).toBeUndefined();
      const record = await recordOf(command.idempotencyKey);
      expect(record?.http_status).toBe(422);
      expect(record?.transaction_id).toBeNull();

      const replay = outcomeOf(await useCase.execute(command));
      expect(replay.replay).toBe(true);
      expect(replay.body).toEqual({ ...result.body, idempotentReplay: true });
    });
  });

  describe('PENDING_REFERENCE', () => {
    it('stores the retry row, the pending event and a 202 record', async () => {
      const wallet = await openWallet();
      const command = commandFor(wallet, {
        kind: WagerTransactionKind.Win,
        money: brl('20.00'),
        referenceExternalTransactionId: `ext-${crypto.randomUUID()}`,
      });

      const result = outcomeOf(await useCase.execute(command));

      expect(result.httpStatus).toBe(202);
      expect(result.body.status).toBe('PENDING_REFERENCE');
      const transactionId = result.body.transactionId ?? '';
      const retries = await query<{ attempts: number; window_ok: boolean; open: boolean }>(
        `SELECT r.attempts,
                r.deadline_at = t.created_at + interval '900000 milliseconds' AS window_ok,
                r.resolved_at IS NULL AND r.locked_until IS NULL AND r.next_attempt_at > t.created_at
                  AS open
         FROM pending_reference_retries r JOIN wager_transactions t ON t.id = r.transaction_id
         WHERE r.transaction_id = $1`,
        [transactionId],
      );
      expect(retries).toEqual([{ attempts: 0, window_ok: true, open: true }]);
      expect(await eventsOf(transactionId)).toEqual(['WagerTransactionPendingReference']);
      expect((await recordOf(command.idempotencyKey))?.http_status).toBe(202);
      expect(await entriesOf(transactionId)).toEqual([]);
      expect(await walletOf(wallet.walletId)).toEqual({ balance: '100.00', version: 1 });
    });

    it('brings the dependent retry forward when the reference is processed', async () => {
      const wallet = await openWallet();
      const betExternalId = `ext-${crypto.randomUUID()}`;
      const pending = outcomeOf(
        await useCase.execute(
          commandFor(wallet, {
            kind: WagerTransactionKind.Win,
            money: brl('20.00'),
            referenceExternalTransactionId: betExternalId,
          }),
        ),
      );

      await useCase.execute(commandFor(wallet, { externalTransactionId: betExternalId }));

      const retries = await query<{ due: boolean }>(
        'SELECT next_attempt_at <= now() AS due FROM pending_reference_retries WHERE transaction_id = $1',
        [pending.body.transactionId],
      );
      expect(retries).toEqual([{ due: true }]);
    });
  });

  describe('external transaction id already used', () => {
    it('records a 409 pointing at the existing transaction and replays it', async () => {
      const wallet = await openWallet();
      const first = commandFor(wallet);
      const placed = outcomeOf(await useCase.execute(first));
      const second = commandFor(wallet, {
        externalTransactionId: first.externalTransactionId,
        money: brl('30.00'),
      });

      const result = await useCase.execute(second);

      expect(result).toEqual({
        kind: 'external-id-conflict',
        replay: false,
        body: {
          type: `urn:jungle:problem:${FailureCode.ExternalTransactionIdConflict}`,
          title: 'External transaction id conflict',
          status: 409,
          detail: 'The external transaction id was already used by another transaction',
          failureCode: FailureCode.ExternalTransactionIdConflict,
          retryable: false,
          action: FailureAction.FixPayload,
          transactionId: placed.body.transactionId ?? '',
          idempotentReplay: false,
        },
      });
      const record = await recordOf(second.idempotencyKey);
      expect(record?.http_status).toBe(409);
      expect(record?.transaction_id).toBeNull();
      expect(await walletOf(wallet.walletId)).toEqual({ balance: '90.00', version: 2 });

      const replay = await useCase.execute(second);
      expect(replay.kind).toBe('external-id-conflict');
      expect(Reflect.get(replay, 'replay')).toBe(true);
    });
  });

  describe('idempotency key used with another payload', () => {
    it('answers the conflict from the fast path and writes nothing', async () => {
      const wallet = await openWallet();
      const command = commandFor(wallet);
      await useCase.execute(command);
      const before = await counts();

      const result = await useCase.execute({ ...command, money: brl('11.00') });

      expect(result.kind).toBe('idempotency-key-conflict');
      expect(Reflect.get(Reflect.get(result, 'body'), 'status')).toBe(409);
      expect(Reflect.get(Reflect.get(result, 'body'), 'failureCode')).toBe(
        FailureCode.IdempotencyKeyConflict,
      );
      expect(await counts()).toEqual(before);
    });
  });

  describe('record that appears between the fast path and the re-check', () => {
    it('answers 409 IDEMPOTENCY_KEY_CONFLICT and rolls everything back', async () => {
      const target = await openWallet();
      const other = await openWallet();
      const idempotencyKey = `key-${crypto.randomUUID()}`;
      const competing = commandFor(other, { idempotencyKey });
      const waiting = commandFor(target, { idempotencyKey, money: brl('15.00') });

      const result = await whileWalletIsLocked(
        target.walletId,
        1,
        () => useCase.execute(waiting),
        async () => {
          outcomeOf(await useCase.execute(competing));
        },
      );

      expect(result).toEqual({
        kind: 'idempotency-key-conflict',
        body: {
          type: `urn:jungle:problem:${FailureCode.IdempotencyKeyConflict}`,
          title: 'Idempotency key conflict',
          status: 409,
          detail: 'The idempotency key was already used with a different payload',
          failureCode: FailureCode.IdempotencyKeyConflict,
          retryable: false,
          action: FailureAction.FixPayload,
        },
      });
      expect(await transactionOf(waiting.externalTransactionId)).toBeUndefined();
      expect(await walletOf(target.walletId)).toEqual({ balance: '100.00', version: 1 });
      const record = await recordOf(idempotencyKey);
      expect(record?.http_status).toBe(200);
      expect(record?.transaction_id).toBe(
        (await transactionOf(competing.externalTransactionId))?.id ?? null,
      );
    });

    it('does not keep the inbox of an sqs delivery that hits the conflict under the lock', async () => {
      const target = await openWallet();
      const other = await openWallet();
      const idempotencyKey = `key-${crypto.randomUUID()}`;
      const waiting = sqsCommandFor(target, { idempotencyKey, money: brl('15.00') });

      const result = await whileWalletIsLocked(
        target.walletId,
        1,
        () => useCase.execute(waiting),
        async () => {
          outcomeOf(await useCase.execute(commandFor(other, { idempotencyKey })));
        },
      );

      expect(result.kind).toBe('idempotency-key-conflict');
      expect(await inboxOf(waiting.inbox?.messageId ?? '')).toBeUndefined();
      expect(await transactionOf(waiting.externalTransactionId)).toBeUndefined();
    });

    it('replays the competing outcome when the record that appears matches', async () => {
      const wallet = await openWallet();
      const command = commandFor(wallet);

      const [first, second] = await whileWalletIsLocked(wallet.walletId, 2, () =>
        Promise.all([useCase.execute(command), useCase.execute(command)]),
      );

      const outcomes = [outcomeOf(first), outcomeOf(second)];
      expect(outcomes.map((outcome) => outcome.replay).sort()).toEqual([false, true]);
      expect(outcomes[0]?.body.transactionId).toBe(outcomes[1]?.body.transactionId ?? '');
      expect(await walletOf(wallet.walletId)).toEqual({ balance: '90.00', version: 2 });
      const stored = await query<{ total: number }>(
        'SELECT count(*)::int AS total FROM wager_transactions WHERE provider_id = $1',
        [PROVIDER],
      );
      expect(stored).toEqual([{ total: 1 }]);
    });
  });

  describe('sqs channel', () => {
    it('marks the inbox as processed in the same transaction', async () => {
      const wallet = await openWallet();
      const command = sqsCommandFor(wallet);

      const result = outcomeOf(await useCase.execute(command));

      expect(result.body.status).toBe('PROCESSED');
      expect(await inboxOf(command.inbox?.messageId ?? '')).toEqual({ processed: true });
    });

    it('replays a duplicate delivery without writing anything else', async () => {
      const wallet = await openWallet();
      const command = sqsCommandFor(wallet);
      const first = outcomeOf(await useCase.execute(command));
      const before = await counts();

      const replay = outcomeOf(await useCase.execute(command));

      expect(replay.replay).toBe(true);
      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
      expect(await counts()).toEqual(before);
    });

    it('answers inbox-payload-mismatch when the same message carries another payload', async () => {
      const wallet = await openWallet();
      const command = sqsCommandFor(wallet);
      await useCase.execute(command);
      const before = await counts();

      const result = await useCase.execute({
        ...command,
        inbox: { messageId: command.inbox?.messageId ?? '', payloadHash: hasher.sha256Hex('x') },
      });

      expect(result).toEqual({ kind: 'inbox-payload-mismatch' });
      expect(await counts()).toEqual(before);
    });

    it('marks the inbox of a WALLET_NOT_FOUND delivery', async () => {
      const command = sqsCommandFor({
        walletId: crypto.randomUUID(),
        playerId: crypto.randomUUID(),
      });

      const result = outcomeOf(await useCase.execute(command));

      expect(result.body.failureCode).toBe(FailureCode.WalletNotFound);
      expect(await inboxOf(command.inbox?.messageId ?? '')).toEqual({ processed: true });
    });
  });
});
