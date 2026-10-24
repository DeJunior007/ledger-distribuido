import { describe, expect, it } from 'bun:test';
import { FakeLogger } from '@test/support/fakes/logger.fake';
import { FakeMetrics } from '@test/support/fakes/metrics.fake';
import { FixedClock } from '@test/support/fixed-clock';
import { SequentialIds } from '@test/support/sequential-ids';
import { NotFoundError } from '@application/errors/not-found.error';
import { ReconcileWalletUseCase } from '@application/use-cases/reconcile-wallet.use-case';
import { at, rejection } from './fixtures';
import {
  RecordingUnitOfWork,
  credit,
  debit,
  overwriteWallet,
  seedHouseAccounts,
  seedLedgerWallet,
} from './reconciliation-fixtures';

const setup = () => {
  const clock = new FixedClock(at);
  const uow = new RecordingUnitOfWork(clock);
  const metrics = new FakeMetrics();
  const logger = new FakeLogger();
  seedHouseAccounts(uow, 'BRL');
  const useCase = new ReconcileWalletUseCase(uow, new SequentialIds(), clock, metrics, logger);
  const reconcile = (walletId = 'wallet-1') =>
    useCase.execute({ walletId, correlationId: 'corr-1' });
  return { uow, metrics, logger, reconcile };
};

const seedPlayedWallet = (uow: RecordingUnitOfWork, omittedVersions: number[] = []): void => {
  seedLedgerWallet(uow, {
    id: 'wallet-1',
    movements: [credit('100.00'), debit('30.00'), credit('20.00')],
    omittedVersions,
  });
};

describe('ReconcileWalletUseCase', () => {
  it('reports a consistent wallet opened with an initial balance', async () => {
    const { uow, metrics, logger, reconcile } = setup();
    seedPlayedWallet(uow);

    const report = await reconcile();

    expect(report.walletId).toBe('wallet-1');
    expect(report.storedBalance.toJSON()).toStrictEqual({ amount: '90.00', currency: 'BRL' });
    expect(report.calculatedBalance.toJSON()).toStrictEqual({ amount: '90.00', currency: 'BRL' });
    expect(report.difference.toJSON()).toStrictEqual({ amount: '0.00', currency: 'BRL' });
    expect(report.consistent).toBe(true);
    expect(report.checkedEntries).toBe(3);
    expect(report.chain).toStrictEqual({
      valid: true,
      firstDivergentVersion: undefined,
      problems: [],
    });
    expect(report.checkedAt).toStrictEqual(at);
    expect(
      metrics.counter('reconciliation_runs_total', { scope: 'wallet', consistent: 'true' }),
    ).toBe(1);
    expect(metrics.counter('reconciliation_mismatch_total', { scope: 'wallet' })).toBe(0);
    expect(logger.entriesAt('error')).toHaveLength(0);
  });

  it('reports a consistent wallet opened with zero and an empty wallet', async () => {
    const { uow, reconcile } = setup();
    seedLedgerWallet(uow, {
      id: 'wallet-1',
      openedWithZero: true,
      movements: [credit('15.00'), debit('5.00')],
    });
    seedLedgerWallet(uow, { id: 'wallet-2', movements: [] });

    const played = await reconcile('wallet-1');
    const empty = await reconcile('wallet-2');

    expect(played.consistent).toBe(true);
    expect(played.storedBalance.toJSON().amount).toBe('10.00');
    expect(empty.consistent).toBe(true);
    expect(empty.checkedEntries).toBe(0);
    expect(empty.difference.isZero()).toBe(true);
  });

  it('records the run in a short transaction after the reconciliation snapshot', async () => {
    const { uow, reconcile } = setup();
    seedPlayedWallet(uow);

    const report = await reconcile();

    expect(uow.kinds).toStrictEqual(['reconciliation', 'short']);
    const runs = uow.database.reconciliationRuns.rows();
    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run?.id).toBe(report.runId);
    expect(run?.scope).toBe('WALLET');
    expect(run?.walletId).toBe('wallet-1');
    expect(run?.consistent).toBe(true);
    expect(run?.checkedEntries).toBe(3);
    expect(run?.stored?.toJSON().amount).toBe('90.00');
    expect(run?.calculated?.toJSON().amount).toBe('90.00');
    expect(run?.difference?.toJSON().amount).toBe('0.00');
    expect(run?.currency).toBe('BRL');
    expect(run?.firstDivergentVersion).toBeUndefined();
    expect(run?.details).toStrictEqual({ problems: [] });
    expect(run?.startedAt).toStrictEqual(at);
    expect(run?.finishedAt).toStrictEqual(at);
  });

  it('reports a positive difference when the stored balance was raised', async () => {
    const { uow, metrics, logger, reconcile } = setup();
    seedPlayedWallet(uow);
    overwriteWallet(uow, 'wallet-1', { balance: '95.00' });

    const report = await reconcile();

    expect(report.consistent).toBe(false);
    expect(report.difference.toJSON().amount).toBe('5.00');
    expect(report.calculatedBalance.toJSON().amount).toBe('90.00');
    expect(report.chain).toStrictEqual({
      valid: false,
      firstDivergentVersion: 3,
      problems: ['LAST_BALANCE_MISMATCH'],
    });
    expect(
      metrics.counter('reconciliation_runs_total', { scope: 'wallet', consistent: 'false' }),
    ).toBe(1);
    expect(metrics.counter('reconciliation_mismatch_total', { scope: 'wallet' })).toBe(1);
    expect(logger.entriesAt('error')).toStrictEqual([
      {
        level: 'error',
        message: 'wallet reconciliation found a divergence',
        fields: {
          correlationId: 'corr-1',
          walletId: 'wallet-1',
          firstDivergentVersion: 3,
          problems: ['LAST_BALANCE_MISMATCH'],
        },
      },
    ]);
  });

  it('reports a negative difference when the stored balance was lowered', async () => {
    const { uow, reconcile } = setup();
    seedPlayedWallet(uow);
    overwriteWallet(uow, 'wallet-1', { balance: '85.00' });

    const report = await reconcile();

    expect(report.consistent).toBe(false);
    expect(report.difference.toJSON().amount).toBe('-5.00');
    const [run] = uow.database.reconciliationRuns.rows();
    expect(run?.difference?.toJSON().amount).toBe('-5.00');
    expect(run?.consistent).toBe(false);
    expect(run?.firstDivergentVersion).toBe(3);
  });

  it('points to the first divergent version when an entry is missing', async () => {
    const { uow, logger, reconcile } = setup();
    seedPlayedWallet(uow, [2]);

    const report = await reconcile();

    expect(report.consistent).toBe(false);
    expect(report.checkedEntries).toBe(2);
    expect(report.difference.toJSON().amount).toBe('-30.00');
    expect(report.chain.firstDivergentVersion).toBe(3);
    expect(report.chain.problems).toStrictEqual(['VERSION_GAP', 'BEFORE_AFTER_MISMATCH']);
    expect(JSON.stringify(logger.entries)).not.toContain('30.00');
  });

  it('never corrects the divergent wallet', async () => {
    const { uow, reconcile } = setup();
    seedPlayedWallet(uow);
    overwriteWallet(uow, 'wallet-1', { balance: '95.00' });

    await reconcile();

    const wallet = uow.database.wallets.get('wallet-1');
    expect(wallet?.balance.toJSON().amount).toBe('95.00');
    expect(wallet?.version).toBe(3);
    expect(uow.database.walletEntries.rows()).toHaveLength(3);
  });

  it('fails with not found and records nothing when the wallet does not exist', async () => {
    const { uow, metrics, reconcile } = setup();

    expect(await rejection(reconcile('missing'))).toBeInstanceOf(NotFoundError);
    expect(uow.database.reconciliationRuns.rows()).toHaveLength(0);
    expect(
      metrics.counter('reconciliation_runs_total', { scope: 'wallet', consistent: 'true' }),
    ).toBe(0);
  });
});
