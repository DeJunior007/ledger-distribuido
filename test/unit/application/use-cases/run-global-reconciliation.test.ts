import { describe, expect, it } from 'bun:test';
import { FakeLogger } from '@test/support/fakes/logger.fake';
import { FakeMetrics } from '@test/support/fakes/metrics.fake';
import { FixedClock } from '@test/support/fixed-clock';
import { SequentialIds } from '@test/support/sequential-ids';
import { ReconcileWalletUseCase } from '@application/use-cases/reconcile-wallet.use-case';
import { RunGlobalReconciliationUseCase } from '@application/use-cases/run-global-reconciliation.use-case';
import { at } from './fixtures';
import {
  RecordingUnitOfWork,
  credit,
  debit,
  overwriteWallet,
  seedHouseAccounts,
  seedLedgerWallet,
} from './reconciliation-fixtures';

const intervalMs = 300_000;

const setup = () => {
  const clock = new FixedClock(at);
  const uow = new RecordingUnitOfWork(clock);
  const metrics = new FakeMetrics();
  const logger = new FakeLogger();
  const ids = new SequentialIds();
  seedHouseAccounts(uow, 'BRL');
  seedHouseAccounts(uow, 'USD');
  const reconcileWallet = new ReconcileWalletUseCase(uow, ids, clock, metrics, logger);
  const replica = (instanceId: string) =>
    new RunGlobalReconciliationUseCase(uow, reconcileWallet, ids, clock, metrics, logger, {
      instanceId,
      intervalMs,
    });
  const primary = replica('instance-a');
  const run = () => primary.execute({ correlationId: 'corr-1' });
  return { clock, uow, metrics, logger, replica, run };
};

const seedHealthyWallets = (uow: RecordingUnitOfWork): void => {
  seedLedgerWallet(uow, {
    id: 'wallet-1',
    movements: [credit('100.00'), debit('30.00'), credit('45.00')],
  });
  seedLedgerWallet(uow, { id: 'wallet-2', movements: [credit('50.00'), debit('50.00')] });
  seedLedgerWallet(uow, {
    id: 'wallet-3',
    currency: 'USD',
    openedWithZero: true,
    movements: [credit('12.50')],
  });
  seedLedgerWallet(uow, { id: 'wallet-4', currency: 'USD', movements: [] });
};

const runsOf = (uow: RecordingUnitOfWork, scope: 'WALLET' | 'GLOBAL') =>
  uow.database.reconciliationRuns.rows().filter((run) => run.scope === scope);

describe('RunGlobalReconciliationUseCase', () => {
  it('records a consistent global run when every currency closes', async () => {
    const { uow, metrics, logger, run } = setup();
    seedHealthyWallets(uow);

    const result = await run();

    expect(result.ran).toBe(true);
    const [global] = runsOf(uow, 'GLOBAL');
    expect(result).toStrictEqual({
      ran: true,
      runId: global?.id ?? '',
      consistent: true,
      suspiciousWallets: 0,
    });
    expect(global?.consistent).toBe(true);
    expect(global?.checkedEntries).toBe(6);
    expect(global?.walletId).toBeUndefined();
    expect(global?.difference).toBeUndefined();
    expect(global?.details).toStrictEqual({
      currencies: [
        {
          currency: 'BRL',
          walletsTotal: '115.00',
          fundingBalance: '-150.00',
          gamingBalance: '35.00',
          ledgerNet: '0.00',
          consistent: true,
        },
        {
          currency: 'USD',
          walletsTotal: '12.50',
          fundingBalance: '0.00',
          gamingBalance: '-12.50',
          ledgerNet: '0.00',
          consistent: true,
        },
      ],
      walletsChecked: 4,
      suspiciousWallets: [],
    });
    expect(runsOf(uow, 'WALLET')).toHaveLength(0);
    expect(
      metrics.counter('reconciliation_runs_total', { scope: 'global', consistent: 'true' }),
    ).toBe(1);
    expect(metrics.counter('reconciliation_mismatch_total', { scope: 'global' })).toBe(0);
    expect(logger.entriesAt('error')).toHaveLength(0);
  });

  it('acquires the lease, snapshots each step and completes the job', async () => {
    const { uow, run } = setup();
    seedHealthyWallets(uow);

    await run();

    expect(uow.kinds).toStrictEqual([
      'short',
      'reconciliation',
      'reconciliation',
      'short',
      'short',
    ]);
    const job = uow.database.scheduledJobs.get('global-reconciliation');
    expect(job).toStrictEqual({
      name: 'global-reconciliation',
      lockedUntil: undefined,
      lockedBy: undefined,
      lastRunAt: at,
    });
  });

  it('reconciles a wallet whose balance was corrupted and flags the global run', async () => {
    const { uow, metrics, logger, run } = setup();
    seedHealthyWallets(uow);
    overwriteWallet(uow, 'wallet-2', { balance: '7.00' });

    const result = await run();

    expect(result).toMatchObject({ ran: true, consistent: false, suspiciousWallets: 1 });
    const [walletRun] = runsOf(uow, 'WALLET');
    expect(walletRun?.walletId).toBe('wallet-2');
    expect(walletRun?.difference?.toJSON().amount).toBe('7.00');
    const [global] = runsOf(uow, 'GLOBAL');
    expect(global?.consistent).toBe(false);
    expect(global?.details).toMatchObject({
      currencies: [
        { currency: 'BRL', walletsTotal: '122.00', consistent: false },
        { currency: 'USD', consistent: true },
      ],
      walletsChecked: 4,
      suspiciousWallets: ['wallet-2'],
    });
    expect(
      metrics.counter('reconciliation_runs_total', { scope: 'global', consistent: 'false' }),
    ).toBe(1);
    expect(metrics.counter('reconciliation_mismatch_total', { scope: 'global' })).toBe(1);
    expect(metrics.counter('reconciliation_mismatch_total', { scope: 'wallet' })).toBe(1);
    expect(logger.entriesAt('error').map((entry) => entry.message)).toStrictEqual([
      'wallet reconciliation found a divergence',
      'global reconciliation found a divergence',
    ]);
    expect(uow.database.wallets.get('wallet-2')?.balance.toJSON().amount).toBe('7.00');
  });

  it('flags wallets whose versions break the chain even when the sums close', async () => {
    const { uow, run } = setup();
    seedHealthyWallets(uow);
    overwriteWallet(uow, 'wallet-1', { version: 4 });
    overwriteWallet(uow, 'wallet-4', { version: 2 });
    seedLedgerWallet(uow, {
      id: 'wallet-5',
      movements: [credit('10.00'), credit('5.00'), debit('3.00')],
      omittedVersions: [2],
    });
    overwriteWallet(uow, 'wallet-5', { balance: '7.00' });

    const result = await run();

    expect(result).toMatchObject({ ran: true, consistent: false, suspiciousWallets: 3 });
    const [global] = runsOf(uow, 'GLOBAL');
    expect(global?.details).toMatchObject({
      suspiciousWallets: ['wallet-1', 'wallet-4', 'wallet-5'],
    });
    expect(runsOf(uow, 'WALLET').map((walletRun) => walletRun.walletId)).toStrictEqual([
      'wallet-1',
      'wallet-4',
      'wallet-5',
    ]);
  });

  it('pages through wallets in batches and sums every checked entry', async () => {
    const { uow, run } = setup();
    for (let index = 1; index <= 501; index += 1) {
      seedLedgerWallet(uow, {
        id: `wallet-${String(index).padStart(4, '0')}`,
        movements: [credit('1.00')],
      });
    }
    overwriteWallet(uow, 'wallet-0501', { balance: '2.00' });

    const result = await run();

    expect(result).toMatchObject({ ran: true, consistent: false, suspiciousWallets: 1 });
    const [global] = runsOf(uow, 'GLOBAL');
    expect(global?.checkedEntries).toBe(501);
    expect(global?.details).toMatchObject({
      walletsChecked: 501,
      suspiciousWallets: ['wallet-0501'],
    });
  });

  it('reports at most one hundred suspicious wallets', async () => {
    const { uow, run } = setup();
    for (let index = 1; index <= 101; index += 1) {
      const id = `wallet-${String(index).padStart(4, '0')}`;
      seedLedgerWallet(uow, { id, movements: [credit('1.00')] });
      overwriteWallet(uow, id, { balance: '2.00' });
    }

    const result = await run();

    expect(result).toMatchObject({ ran: true, suspiciousWallets: 101 });
    const [global] = runsOf(uow, 'GLOBAL');
    const details = global?.details ?? {};
    expect(details.suspiciousWallets).toHaveLength(100);
    expect(runsOf(uow, 'WALLET')).toHaveLength(101);
  });

  it('skips the run while another replica holds the lease', async () => {
    const { clock, uow, replica } = setup();
    seedHealthyWallets(uow);
    uow.database.scheduledJobs.put({
      name: 'global-reconciliation',
      lockedUntil: new Date(clock.now().getTime() + 60_000),
      lockedBy: 'instance-b',
      lastRunAt: undefined,
    });

    const result = await replica('instance-a').execute({ correlationId: 'corr-1' });

    expect(result).toStrictEqual({ ran: false });
    expect(uow.kinds).toStrictEqual(['short']);
    expect(uow.database.reconciliationRuns.rows()).toHaveLength(0);
  });

  it('runs once per interval across replicas', async () => {
    const { clock, uow, replica, run } = setup();
    seedHealthyWallets(uow);

    const first = await run();
    clock.advance(intervalMs - 1);
    const tooSoon = await replica('instance-b').execute({ correlationId: 'corr-2' });
    clock.advance(1);
    const next = await replica('instance-b').execute({ correlationId: 'corr-3' });

    expect(first.ran).toBe(true);
    expect(tooSoon).toStrictEqual({ ran: false });
    expect(next.ran).toBe(true);
    expect(runsOf(uow, 'GLOBAL')).toHaveLength(2);
    expect(uow.database.scheduledJobs.get('global-reconciliation')?.lastRunAt).toStrictEqual(
      clock.now(),
    );
  });
});
