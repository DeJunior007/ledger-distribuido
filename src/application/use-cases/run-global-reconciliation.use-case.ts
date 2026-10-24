import { ClockPort } from '@application/ports/clock.port';
import { IdGeneratorPort } from '@application/ports/id-generator.port';
import { LoggerPort } from '@application/ports/logger.port';
import { MetricsPort } from '@application/ports/metrics.port';
import type {
  CurrencySums,
  WalletBatchRow,
} from '@application/ports/repositories/reconciliation-repository.port';
import { UnitOfWorkPort } from '@application/ports/unit-of-work.port';
import { Money } from '@domain/shared/money';
import { ReconcileWalletUseCase } from './reconcile-wallet.use-case';

export interface RunGlobalReconciliationCommand {
  correlationId: string;
}

export type GlobalReconciliationResult =
  { ran: false } | { ran: true; runId: string; consistent: boolean; suspiciousWallets: number };

export interface RunGlobalReconciliationConfig {
  instanceId: string;
  intervalMs: number;
}

interface CurrencyCheck {
  currency: string;
  walletsTotal: string;
  fundingBalance: string;
  gamingBalance: string;
  ledgerNet: string;
  consistent: boolean;
}

const JOB_NAME = 'global-reconciliation';
const LEASE_MS = 600_000;
const WALLET_BATCH_SIZE = 500;
const SUSPICIOUS_WALLETS_REPORTED = 100;

const checkCurrency = (sums: CurrencySums): CurrencyCheck => {
  const signed = (amount: string): Money => Money.fromSignedDecimal(amount, sums.currency);
  const accountsTotal = signed(sums.walletsTotal)
    .add(signed(sums.fundingBalance))
    .add(signed(sums.gamingBalance));
  return {
    currency: sums.currency,
    walletsTotal: sums.walletsTotal,
    fundingBalance: sums.fundingBalance,
    gamingBalance: sums.gamingBalance,
    ledgerNet: sums.ledgerNet,
    consistent: accountsTotal.isZero() && signed(sums.ledgerNet).isZero(),
  };
};

const hasValidFirstVersion = (firstVersion: number): boolean =>
  firstVersion === 1 || firstVersion === 2;

const isSuspicious = (row: WalletBatchRow): boolean => {
  if (row.calculated !== row.balance) {
    return true;
  }
  if (row.entries === 0) {
    return row.version !== 1;
  }
  const { firstVersion, lastVersion } = row;
  if (firstVersion === undefined || lastVersion === undefined) {
    return true;
  }
  return (
    lastVersion !== row.version ||
    row.entries !== lastVersion - firstVersion + 1 ||
    !hasValidFirstVersion(firstVersion)
  );
};

export class RunGlobalReconciliationUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly reconcileWallet: ReconcileWalletUseCase,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
    private readonly metrics: MetricsPort,
    private readonly logger: LoggerPort,
    private readonly config: RunGlobalReconciliationConfig,
  ) {}

  async execute(command: RunGlobalReconciliationCommand): Promise<GlobalReconciliationResult> {
    const acquired = await this.unitOfWork.run('short', (repos) =>
      repos.scheduledJobs.tryAcquire(
        JOB_NAME,
        this.config.instanceId,
        LEASE_MS,
        this.config.intervalMs,
      ),
    );
    if (!acquired) {
      return { ran: false };
    }

    const startedAt = this.clock.now();
    const sums = await this.unitOfWork.run('reconciliation', (repos) =>
      repos.reconciliation.globalSums(),
    );
    const currencies = sums.map(checkCurrency);

    const suspicious: string[] = [];
    let walletsChecked = 0;
    let checkedEntries = 0;
    let afterId: string | undefined;
    let batch: WalletBatchRow[];
    do {
      const cursor = afterId;
      batch = await this.unitOfWork.run('reconciliation', (repos) =>
        repos.reconciliation.walletBatch(cursor, WALLET_BATCH_SIZE),
      );
      for (const row of batch) {
        walletsChecked += 1;
        checkedEntries += row.entries;
        if (isSuspicious(row)) {
          suspicious.push(row.walletId);
          await this.reconcileWallet.execute({
            walletId: row.walletId,
            correlationId: command.correlationId,
          });
        }
      }
      afterId = batch[batch.length - 1]?.walletId;
    } while (batch.length === WALLET_BATCH_SIZE);

    const consistent =
      currencies.every((currency) => currency.consistent) && suspicious.length === 0;
    const runId = this.ids.next();
    const finishedAt = this.clock.now();
    await this.unitOfWork.run('short', (repos) => {
      repos.reconciliation.insertRun({
        id: runId,
        scope: 'GLOBAL',
        walletId: undefined,
        consistent,
        checkedEntries,
        stored: undefined,
        calculated: undefined,
        difference: undefined,
        currency: undefined,
        firstDivergentVersion: undefined,
        details: {
          currencies,
          walletsChecked,
          suspiciousWallets: suspicious.slice(0, SUSPICIOUS_WALLETS_REPORTED),
        },
        startedAt,
        finishedAt,
      });
      return Promise.resolve();
    });

    this.metrics.reconciliationRun('global', consistent);
    if (!consistent) {
      this.metrics.reconciliationMismatch('global');
      this.logger.error('global reconciliation found a divergence', {
        correlationId: command.correlationId,
      });
    }

    await this.unitOfWork.run('short', (repos) =>
      repos.scheduledJobs.complete(JOB_NAME, this.config.instanceId, this.clock.now()),
    );

    return { ran: true, runId, consistent, suspiciousWallets: suspicious.length };
  }
}
