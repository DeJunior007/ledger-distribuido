import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import type { QueryResultRow } from 'pg';
import type {
  SubmitResult,
  SubmitWagerTransactionCommand,
} from '@application/commands/submit-wager-transaction.command';
import { TRUSTED_CHANNEL } from '@application/ports/provider-identity.port';
import { AnomalyDetector } from '@application/services/anomaly-detector';
import { OutcomeMapper } from '@application/services/outcome-mapper';
import { CreateWalletUseCase } from '@application/use-cases/create-wallet.use-case';
import { SubmitWagerTransactionUseCase } from '@application/use-cases/submit-wager-transaction.use-case';
import { FailureCode } from '@domain/shared/failure-code';
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

const PROVIDER = 'provider-wagering-race';
const CURRENCY = 'BRL';
const CONTENDERS = 6;
const LOCK_WAIT = { timeoutMs: 2_000, intervalMs: 10 } as const;

const clock = new SystemClock();
const ids = new Uuidv7IdGenerator();
const hasher = new Sha256Hasher();
const tracer = new NoopTracer();
const metrics = new PromMetricsAdapter(createMetricsRegistry().metrics);
const logger = new PinoLoggerAdapter(
  createLogger({ level: 'silent', service: 'wagering-race', instanceId: 'wagering-race' }),
);

interface WalletFixture {
  readonly walletId: string;
  readonly playerId: string;
}

interface StoredWallet {
  readonly balance: string;
  readonly version: number;
}

interface StoredRecord {
  readonly http_status: number;
  readonly transaction_id: string | null;
  readonly conflicting_transaction_id: string | null;
}

interface WalletLockHolder {
  release(): Promise<void>;
}

const failureOf = <T>(promise: Promise<T>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );

const brl = (amount: string) => ({ amount, currency: CURRENCY });

const processedOf = (results: readonly SubmitResult[]): SubmitResult[] =>
  results.filter((result) => result.kind === 'outcome');

const conflictsOf = (results: readonly SubmitResult[]): SubmitResult[] =>
  results.filter((result) => result.kind === 'external-id-conflict');

describe('same externalTransactionId with different keys in parallel on postgres', () => {
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

  const openWallet = async (): Promise<WalletFixture> => {
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
      initialBalance: brl('100.00'),
      correlationId: crypto.randomUUID(),
      causationId: crypto.randomUUID(),
    });
    return { walletId: view.id, playerId: view.playerId };
  };

  const commandFor = (
    wallet: WalletFixture,
    externalTransactionId: string,
    overrides: Partial<SubmitWagerTransactionCommand> = {},
  ): SubmitWagerTransactionCommand => ({
    channel: 'http',
    identity: { kind: 'provider', providerId: PROVIDER, clientId: 'client-wagering-race' },
    providerId: PROVIDER,
    externalTransactionId,
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

  const contenders = (
    wallets: readonly WalletFixture[],
    externalTransactionId: string,
  ): SubmitWagerTransactionCommand[] =>
    Array.from({ length: CONTENDERS }, (_, index) => {
      const wallet = wallets[index % wallets.length];
      if (wallet === undefined) {
        throw new RangeError('no wallet for this contender');
      }
      return commandFor(wallet, externalTransactionId);
    });

  const walletOf = async (walletId: string): Promise<StoredWallet | undefined> => {
    const rows = await query<StoredWallet>(
      'SELECT balance::text AS balance, version FROM wallets WHERE id = $1',
      [walletId],
    );
    return rows[0];
  };

  const transactionsWith = async (externalTransactionId: string): Promise<string[]> => {
    const rows = await query<{ id: string }>(
      'SELECT id FROM wager_transactions WHERE provider_id = $1 AND external_transaction_id = $2',
      [PROVIDER, externalTransactionId],
    );
    return rows.map((row) => row.id);
  };

  const recordsOf = async (
    commands: readonly SubmitWagerTransactionCommand[],
  ): Promise<StoredRecord[]> =>
    query<StoredRecord>(
      `SELECT http_status, transaction_id, response_body->>'transactionId' AS conflicting_transaction_id
       FROM idempotency_records WHERE provider_id = $1 AND idempotency_key = ANY($2::text[])
       ORDER BY http_status`,
      [PROVIDER, commands.map((command) => command.idempotencyKey)],
    );

  const lockWaiters = async (): Promise<number> => {
    const rows = await query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
       WHERE datname = $1 AND usename = 'jungle_app' AND wait_event_type = 'Lock'`,
      [database.name],
    );
    return rows[0]?.waiting ?? 0;
  };

  const holdWalletLocks = async (walletIds: readonly string[]): Promise<WalletLockHolder> => {
    const client = new Client({ connectionString: database.superuserUrl });
    await client.connect();
    await client.query('BEGIN');
    await client.query('SELECT id FROM wallets WHERE id = ANY($1::uuid[]) FOR UPDATE', [walletIds]);
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

  const submitAllWhileLocked = async (
    wallets: readonly WalletFixture[],
    commands: readonly SubmitWagerTransactionCommand[],
  ): Promise<SubmitResult[]> => {
    const holder = await holdWalletLocks(wallets.map((wallet) => wallet.walletId));
    try {
      const pending = Promise.all(commands.map((command) => useCase.execute(command)));
      const settled = failureOf(pending);
      await waitFor(async () => (await lockWaiters()) >= commands.length, LOCK_WAIT);
      await holder.release();
      await settled;
      return await pending;
    } finally {
      await holder.release();
    }
  };

  const expectOneEffect = async (
    results: readonly SubmitResult[],
    commands: readonly SubmitWagerTransactionCommand[],
    externalTransactionId: string,
  ): Promise<string> => {
    expect(processedOf(results)).toHaveLength(1);
    expect(conflictsOf(results)).toHaveLength(CONTENDERS - 1);
    const stored = await transactionsWith(externalTransactionId);
    expect(stored).toHaveLength(1);
    const [winner] = stored;
    for (const conflict of conflictsOf(results)) {
      expect(Reflect.get(conflict, 'replay')).toBe(false);
      expect(Reflect.get(Reflect.get(conflict, 'body'), 'status')).toBe(409);
      expect(Reflect.get(Reflect.get(conflict, 'body'), 'failureCode')).toBe(
        FailureCode.ExternalTransactionIdConflict,
      );
      expect(Reflect.get(Reflect.get(conflict, 'body'), 'transactionId')).toBe(winner);
    }
    const records = await recordsOf(commands);
    expect(records).toEqual([
      {
        http_status: 200,
        transaction_id: winner ?? null,
        conflicting_transaction_id: winner ?? null,
      },
      ...Array.from({ length: CONTENDERS - 1 }, () => ({
        http_status: 409,
        transaction_id: null,
        conflicting_transaction_id: winner ?? null,
      })),
    ]);
    return winner ?? '';
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

  it('applies one effect and answers 409 to the rest when fired together', async () => {
    const wallet = await openWallet();
    const externalTransactionId = `ext-${crypto.randomUUID()}`;
    const commands = contenders([wallet], externalTransactionId);

    const results = await Promise.all(commands.map((command) => useCase.execute(command)));

    await expectOneEffect(results, commands, externalTransactionId);
    expect(await walletOf(wallet.walletId)).toEqual({ balance: '90.00', version: 2 });
  });

  it('answers 409 from the re-check under the lock when every contender passed the first check', async () => {
    const wallet = await openWallet();
    const externalTransactionId = `ext-${crypto.randomUUID()}`;
    const commands = contenders([wallet], externalTransactionId);

    const results = await submitAllWhileLocked([wallet], commands);

    await expectOneEffect(results, commands, externalTransactionId);
    expect(await walletOf(wallet.walletId)).toEqual({ balance: '90.00', version: 2 });
  });

  it('keeps one effect when the contenders hold locks on different wallets', async () => {
    const wallets = [await openWallet(), await openWallet()];
    const externalTransactionId = `ext-${crypto.randomUUID()}`;
    const commands = contenders(wallets, externalTransactionId);

    const results = await submitAllWhileLocked(wallets, commands);

    const winner = await expectOneEffect(results, commands, externalTransactionId);
    const owner = await query<{ wallet_id: string }>(
      'SELECT wallet_id FROM wager_transactions WHERE id = $1',
      [winner],
    );
    for (const wallet of wallets) {
      expect(await walletOf(wallet.walletId)).toEqual(
        wallet.walletId === owner[0]?.wallet_id
          ? { balance: '90.00', version: 2 }
          : { balance: '100.00', version: 1 },
      );
    }
  });

  it('marks the inbox of every sqs delivery, winner and losers alike', async () => {
    const wallet = await openWallet();
    const externalTransactionId = `ext-${crypto.randomUUID()}`;
    const commands = contenders([wallet], externalTransactionId).map((command) => {
      const messageId = crypto.randomUUID();
      return {
        ...command,
        channel: 'sqs' as const,
        identity: TRUSTED_CHANNEL,
        inbox: { messageId, payloadHash: hasher.sha256Hex(messageId) },
      };
    });

    const results = await Promise.all(commands.map((command) => useCase.execute(command)));

    await expectOneEffect(results, commands, externalTransactionId);
    const inbox = await query<{ processed: number }>(
      `SELECT count(*)::int AS processed FROM inbox_messages
       WHERE consumer_name = 'wager-transactions-consumer' AND processed_at IS NOT NULL
         AND message_id = ANY($1::text[])`,
      [commands.map((command) => command.inbox.messageId)],
    );
    expect(inbox).toEqual([{ processed: CONTENDERS }]);
  });
});
