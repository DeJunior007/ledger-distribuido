import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import type { QueryResultRow } from 'pg';
import type {
  SubmitResult,
  SubmitWagerTransactionCommand,
} from '@application/commands/submit-wager-transaction.command';
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

const PROVIDER = 'provider-wagering-reversals';
const CURRENCY = 'BRL';

const clock = new SystemClock();
const ids = new Uuidv7IdGenerator();
const hasher = new Sha256Hasher();
const tracer = new NoopTracer();
const observability = createMetricsRegistry();
const metrics = new PromMetricsAdapter(observability.metrics);
const logger = new PinoLoggerAdapter(
  createLogger({
    level: 'silent',
    service: 'wagering-reversals',
    instanceId: 'wagering-reversals',
  }),
);

class UnexpectedResultError extends Error {
  constructor(actual: string) {
    super(`expected an outcome result, got ${actual}`);
    this.name = 'UnexpectedResultError';
  }
}

interface WalletFixture {
  readonly walletId: string;
  readonly playerId: string;
}

interface StoredWallet {
  readonly balance: string;
  readonly version: number;
}

interface StoredTransaction {
  readonly status: string;
  readonly failure_code: string | null;
  readonly reference_transaction_id: string | null;
  readonly entries: number;
}

type OutcomeResult = Extract<SubmitResult, { kind: 'outcome' }>;

const outcomeOf = (result: SubmitResult): OutcomeResult => {
  if (result.kind !== 'outcome') {
    throw new UnexpectedResultError(result.kind);
  }
  return result;
};

const brl = (amount: string) => ({ amount, currency: CURRENCY });

describe('SubmitWagerTransactionUseCase reversals on postgres', () => {
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
    identity: { kind: 'provider', providerId: PROVIDER, clientId: 'client-wagering-reversals' },
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

  const submit = async (
    wallet: WalletFixture,
    overrides: Partial<SubmitWagerTransactionCommand> = {},
  ): Promise<{ command: SubmitWagerTransactionCommand; outcome: OutcomeResult }> => {
    const command = commandFor(wallet, overrides);
    return { command, outcome: outcomeOf(await useCase.execute(command)) };
  };

  const reversalOf = (
    kind: WagerTransactionKind,
    reference: SubmitWagerTransactionCommand,
  ): Partial<SubmitWagerTransactionCommand> => ({
    kind,
    money: reference.money,
    referenceExternalTransactionId: reference.externalTransactionId,
  });

  const walletOf = async (walletId: string): Promise<StoredWallet | undefined> => {
    const rows = await query<StoredWallet>(
      'SELECT balance::text AS balance, version FROM wallets WHERE id = $1',
      [walletId],
    );
    return rows[0];
  };

  const transactionOf = async (transactionId: string | null): Promise<StoredTransaction> => {
    const rows = await query<StoredTransaction>(
      `SELECT t.status, t.failure_code, t.reference_transaction_id,
              (SELECT count(*)::int FROM ledger_entries e WHERE e.transaction_id = t.id) AS entries
       FROM wager_transactions t WHERE t.id = $1`,
      [transactionId],
    );
    const [row] = rows;
    if (row === undefined) {
      throw new UnexpectedResultError('no stored transaction');
    }
    return row;
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
    observability.metrics.wagerAnomaly.reset();
  });

  afterEach(async () => {
    if (instances !== undefined) {
      await closeOrmInstances(instances);
      instances = undefined;
    }
  });

  it('refunds a BET by crediting the stake back', async () => {
    const wallet = await openWallet();
    const bet = await submit(wallet);

    const refund = await submit(wallet, reversalOf(WagerTransactionKind.Refund, bet.command));

    expect(refund.outcome.body.status).toBe('PROCESSED');
    expect(refund.outcome.body.balance).toEqual(brl('100.00'));
    expect(await transactionOf(refund.outcome.body.transactionId)).toEqual({
      status: 'PROCESSED',
      failure_code: null,
      reference_transaction_id: bet.outcome.body.transactionId,
      entries: 2,
    });
    expect(await walletOf(wallet.walletId)).toEqual({ balance: '100.00', version: 3 });
  });

  it('rejects ROLLBACK(BET) after BET and REFUND because the BET is already reversed', async () => {
    const wallet = await openWallet();
    const bet = await submit(wallet);
    await submit(wallet, reversalOf(WagerTransactionKind.Refund, bet.command));

    const rollback = await submit(wallet, reversalOf(WagerTransactionKind.Rollback, bet.command));

    expect(rollback.outcome.httpStatus).toBe(422);
    expect(rollback.outcome.body.status).toBe('REJECTED');
    expect(rollback.outcome.body.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(await transactionOf(rollback.outcome.body.transactionId)).toEqual({
      status: 'REJECTED',
      failure_code: FailureCode.ReferenceAlreadyReversed,
      reference_transaction_id: bet.outcome.body.transactionId,
      entries: 0,
    });
    expect(await walletOf(wallet.walletId)).toEqual({ balance: '100.00', version: 3 });
  });

  it('accepts ROLLBACK(REFUND) and debits the refunded stake again', async () => {
    const wallet = await openWallet();
    const bet = await submit(wallet);
    const refund = await submit(wallet, reversalOf(WagerTransactionKind.Refund, bet.command));

    const rollback = await submit(
      wallet,
      reversalOf(WagerTransactionKind.Rollback, refund.command),
    );

    expect(rollback.outcome.httpStatus).toBe(200);
    expect(rollback.outcome.body.status).toBe('PROCESSED');
    expect(rollback.outcome.body.balance).toEqual(brl('90.00'));
    expect(await transactionOf(rollback.outcome.body.transactionId)).toEqual({
      status: 'PROCESSED',
      failure_code: null,
      reference_transaction_id: refund.outcome.body.transactionId,
      entries: 2,
    });
    expect(await walletOf(wallet.walletId)).toEqual({ balance: '90.00', version: 4 });
  });

  it('rejects a WIN on a BET that was refunded', async () => {
    const wallet = await openWallet();
    const bet = await submit(wallet);
    await submit(wallet, reversalOf(WagerTransactionKind.Refund, bet.command));

    const win = await submit(wallet, {
      kind: WagerTransactionKind.Win,
      money: brl('30.00'),
      referenceExternalTransactionId: bet.command.externalTransactionId,
    });

    expect(win.outcome.httpStatus).toBe(422);
    expect(win.outcome.body.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect((await transactionOf(win.outcome.body.transactionId)).entries).toBe(0);
    expect(await walletOf(wallet.walletId)).toEqual({ balance: '100.00', version: 3 });
  });

  it('rejects a WIN on a BET that was rolled back', async () => {
    const wallet = await openWallet();
    const bet = await submit(wallet);
    await submit(wallet, reversalOf(WagerTransactionKind.Rollback, bet.command));

    const win = await submit(wallet, {
      kind: WagerTransactionKind.Win,
      money: brl('30.00'),
      referenceExternalTransactionId: bet.command.externalTransactionId,
    });

    expect(win.outcome.body.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(await walletOf(wallet.walletId)).toEqual({ balance: '100.00', version: 3 });
  });

  it('rejects a second REFUND of the same BET', async () => {
    const wallet = await openWallet();
    const bet = await submit(wallet);
    await submit(wallet, reversalOf(WagerTransactionKind.Refund, bet.command));

    const again = await submit(wallet, reversalOf(WagerTransactionKind.Refund, bet.command));

    expect(again.outcome.body.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(await walletOf(wallet.walletId)).toEqual({ balance: '100.00', version: 3 });
  });

  it('rejects a REFUND whose amount differs from the BET', async () => {
    const wallet = await openWallet();
    const bet = await submit(wallet);

    const refund = await submit(wallet, {
      ...reversalOf(WagerTransactionKind.Refund, bet.command),
      money: brl('9.99'),
    });

    expect(refund.outcome.body.failureCode).toBe(FailureCode.AmountMismatch);
    expect(await walletOf(wallet.walletId)).toEqual({ balance: '90.00', version: 2 });
  });

  it('rejects a REFUND of a BET that was rejected', async () => {
    const wallet = await openWallet('5.00');
    const bet = await submit(wallet, { money: brl('50.00') });

    const refund = await submit(wallet, reversalOf(WagerTransactionKind.Refund, bet.command));

    expect(bet.outcome.body.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(refund.outcome.body.failureCode).toBe(FailureCode.ReferenceNotProcessed);
    expect(await walletOf(wallet.walletId)).toEqual({ balance: '5.00', version: 1 });
  });

  it('flags a ROLLBACK(BET) in a round that already has a processed WIN', async () => {
    const wallet = await openWallet();
    const bet = await submit(wallet);
    await submit(wallet, {
      kind: WagerTransactionKind.Win,
      money: brl('30.00'),
      referenceExternalTransactionId: bet.command.externalTransactionId,
    });

    const rollback = await submit(wallet, reversalOf(WagerTransactionKind.Rollback, bet.command));

    expect(rollback.outcome.body.status).toBe('PROCESSED');
    expect(rollback.outcome.body.balance).toEqual(brl('130.00'));
    expect(
      await observability.registry.getSingleMetricAsString('jungle_wager_anomaly_total'),
    ).toContain('jungle_wager_anomaly_total{type="reversal_after_win"} 1');
  });

  it('does not flag a REFUND in a round without a processed WIN', async () => {
    const wallet = await openWallet();
    const bet = await submit(wallet);

    await submit(wallet, reversalOf(WagerTransactionKind.Refund, bet.command));

    expect(
      await observability.registry.getSingleMetricAsString('jungle_wager_anomaly_total'),
    ).not.toContain('reversal_after_win');
  });
});
