import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import type { QueryResultRow } from 'pg';
import { ReconcileWalletUseCase } from '@application/use-cases/reconcile-wallet.use-case';
import { RunGlobalReconciliationUseCase } from '@application/use-cases/run-global-reconciliation.use-case';
import { createLogger } from '@infrastructure/observability/logger';
import { createMetricsRegistry } from '@infrastructure/observability/metrics.registry';
import { PinoLoggerAdapter } from '@infrastructure/observability/pino-logger.adapter';
import { PromMetricsAdapter } from '@infrastructure/observability/prom-metrics.adapter';
import { MikroOrmUnitOfWork } from '@infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock } from '@infrastructure/system/system-clock';
import { Uuidv7IdGenerator } from '@infrastructure/system/uuidv7-id-generator';
import { betCommand, createWalletViaApi, submitViaApi, winCommand } from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import type { WagerTransactionRequest } from '@interfaces/http/schemas/wager-transaction.schema';
import { skipLedgerConsistency } from '@test/support/ledger-consistency';
import { createTestApp } from '@test/support/test-app';
import type { TestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID } from '@test/support/test-issuer';

interface StoredRun extends QueryResultRow {
  readonly scope: string;
  readonly wallet_id: string | null;
  readonly consistent: boolean;
  readonly checked_entries: number;
  readonly details: unknown;
}

interface SeededWallets {
  readonly brlBettor: TestWallet;
  readonly brlWinner: TestWallet;
  readonly usdBettor: TestWallet;
  readonly usdIdle: TestWallet;
}

const clock = new SystemClock();
const ids = new Uuidv7IdGenerator();
const metrics = new PromMetricsAdapter(createMetricsRegistry().metrics);
const logger = new PinoLoggerAdapter(
  createLogger({ level: 'silent', service: 'scheduler', instanceId: 'global-reconciliation' }),
);

let database: TestDatabase;
let app: TestApp;
let operatorToken: string;
let providerToken: string;

const scheduler = (instanceId: string): RunGlobalReconciliationUseCase => {
  const uow = new MikroOrmUnitOfWork(app.orm, app.config);
  return new RunGlobalReconciliationUseCase(
    uow,
    new ReconcileWalletUseCase(uow, ids, clock, metrics, logger),
    ids,
    clock,
    metrics,
    logger,
    { instanceId, intervalMs: app.config.RECONCILIATION_INTERVAL_MS },
  );
};

const withClient = async <T>(work: (client: Client) => Promise<T>): Promise<T> => {
  const client = new Client({ connectionString: database.superuserUrl });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
};

const storedRuns = (): Promise<StoredRun[]> =>
  withClient(
    async (client) =>
      (
        await client.query<StoredRun>(
          `SELECT scope, wallet_id, consistent, checked_entries, details
           FROM reconciliation_runs ORDER BY scope, started_at`,
        )
      ).rows,
  );

const submitProcessed = async (request: WagerTransactionRequest): Promise<void> => {
  const response = await submitViaApi(app.baseUrl, providerToken, request);
  expect(response.status).toBe(200);
};

const seedWallets = async (): Promise<SeededWallets> => {
  const usd = { amount: '500.00', currency: 'USD' };
  const brlBettor = await createWalletViaApi(app.baseUrl, operatorToken);
  const brlWinner = await createWalletViaApi(app.baseUrl, operatorToken);
  const usdBettor = await createWalletViaApi(app.baseUrl, operatorToken, { initialBalance: usd });
  const usdIdle = await createWalletViaApi(app.baseUrl, operatorToken, { initialBalance: usd });
  await submitProcessed(betCommand({ wallet: brlBettor, amount: '25.00' }));
  const bet = betCommand({ wallet: brlWinner, amount: '10.00' });
  await submitProcessed(bet);
  await submitProcessed(
    winCommand({
      wallet: brlWinner,
      amount: '30.00',
      roundId: bet.body.roundId,
      referenceExternalTransactionId: bet.body.externalTransactionId,
    }),
  );
  await submitProcessed(betCommand({ wallet: usdBettor, amount: '7.50', currency: 'USD' }));
  return { brlBettor, brlWinner, usdBettor, usdIdle };
};

const currencyCheck = (
  currency: string,
  walletsTotal: string,
  fundingBalance: string,
  gamingBalance: string,
) => ({
  currency,
  walletsTotal,
  fundingBalance,
  gamingBalance,
  ledgerNet: '0.00',
  consistent: true,
});

beforeEach(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ roles: ['api'], env: { DATABASE_URL: database.appUrl } });
  operatorToken = await app.issuer.token({ role: 'operator' });
  providerToken = await app.issuer.token({ role: 'provider', providerId: TEST_PROVIDER_ID });
});

afterEach(async () => {
  await app.stop();
});

describe('global reconciliation', () => {
  it('closes several wallets in two currencies', async () => {
    await seedWallets();

    const result = await scheduler('scheduler-a').execute({ correlationId: 'global-consistent' });

    expect(result).toMatchObject({ ran: true, consistent: true, suspiciousWallets: 0 });
    expect(typeof Reflect.get(result, 'runId')).toBe('string');
    const runs = await storedRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      scope: 'GLOBAL',
      wallet_id: null,
      consistent: true,
      checked_entries: 8,
      details: { walletsChecked: 4, suspiciousWallets: [] },
    });
    const details: unknown = runs[0]?.details;
    expect(Reflect.get(Object(details), 'currencies')).toEqual(
      expect.arrayContaining([
        currencyCheck('BRL', '1995.00', '-2000.00', '5.00'),
        currencyCheck('USD', '992.50', '-1000.00', '7.50'),
      ]),
    );
  });

  it('lists a corrupted wallet among the suspicious wallets', async () => {
    skipLedgerConsistency('one wallet balance is corrupted on purpose to make it suspicious');
    const { usdBettor } = await seedWallets();
    await withClient(async (client) => {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query('UPDATE wallets SET balance = 495.00 WHERE id = $1', [usdBettor.id]);
      await client.query('COMMIT');
    });

    const result = await scheduler('scheduler-a').execute({ correlationId: 'global-divergent' });

    expect(result).toMatchObject({ ran: true, consistent: false, suspiciousWallets: 1 });
    const runs = await storedRuns();
    expect(runs).toMatchObject([
      {
        scope: 'GLOBAL',
        consistent: false,
        details: { walletsChecked: 4, suspiciousWallets: [usdBettor.id] },
      },
      { scope: 'WALLET', wallet_id: usdBettor.id, consistent: false },
    ]);
  });

  it('runs on only one of two scheduler replicas per interval', async () => {
    await seedWallets();
    const replicas = [scheduler('scheduler-a'), scheduler('scheduler-b')];

    const first = await Promise.all(
      replicas.map((replica) => replica.execute({ correlationId: 'global-first' })),
    );
    expect(first.filter((result) => result.ran)).toHaveLength(1);

    const second = await Promise.all(
      replicas.map((replica) => replica.execute({ correlationId: 'global-second' })),
    );
    expect(second).toEqual([{ ran: false }, { ran: false }]);

    const runs = await storedRuns();
    expect(runs.filter((run) => run.scope === 'GLOBAL')).toHaveLength(1);
  });
});
