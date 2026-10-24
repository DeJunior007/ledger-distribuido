import { NotFoundError } from '@application/errors/not-found.error';
import { ClockPort } from '@application/ports/clock.port';
import { IdGeneratorPort } from '@application/ports/id-generator.port';
import { LoggerPort } from '@application/ports/logger.port';
import { MetricsPort } from '@application/ports/metrics.port';
import type { WalletSnapshot } from '@application/ports/repositories/reconciliation-repository.port';
import { UnitOfWorkPort } from '@application/ports/unit-of-work.port';
import { verifyLedgerChain, type ChainRow } from '@domain/reconciliation/ledger-chain';
import type { WalletReconciliationReport } from '@domain/reconciliation/reconciliation-report';
import { Money } from '@domain/shared/money';

export interface ReconcileWalletCommand {
  walletId: string;
  correlationId: string;
}

const chainRowsOf = (snapshot: WalletSnapshot): ChainRow[] =>
  snapshot.chain.map((row) => ({
    walletVersion: row.walletVersion,
    direction: row.direction,
    amount: Money.fromPersistence(row.amount, row.currency),
    balanceBefore: Money.fromPersistence(row.balanceBefore, row.currency),
    balanceAfter: Money.fromPersistence(row.balanceAfter, row.currency),
  }));

export class ReconcileWalletUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
    private readonly metrics: MetricsPort,
    private readonly logger: LoggerPort,
  ) {}

  async execute(command: ReconcileWalletCommand): Promise<WalletReconciliationReport> {
    const startedAt = this.clock.now();
    const snapshot = await this.unitOfWork.run('reconciliation', (repos) =>
      repos.reconciliation.walletSnapshot(command.walletId),
    );
    if (snapshot === undefined) {
      throw new NotFoundError('wallet not found');
    }

    const storedBalance = Money.fromPersistence(snapshot.balance, snapshot.currency);
    const calculatedBalance = Money.fromSignedDecimal(snapshot.credits, snapshot.currency).subtract(
      Money.fromSignedDecimal(snapshot.debits, snapshot.currency),
    );
    const difference = storedBalance.subtract(calculatedBalance);
    const chain = verifyLedgerChain({
      rows: chainRowsOf(snapshot),
      walletVersion: snapshot.version,
      storedBalance,
    });
    const consistent = difference.isZero() && chain.valid;

    const runId = this.ids.next();
    const finishedAt = this.clock.now();
    await this.unitOfWork.run('short', (repos) => {
      repos.reconciliation.insertRun({
        id: runId,
        scope: 'WALLET',
        walletId: snapshot.walletId,
        consistent,
        checkedEntries: snapshot.entries,
        stored: storedBalance,
        calculated: calculatedBalance,
        difference,
        currency: snapshot.currency,
        firstDivergentVersion: chain.firstDivergentVersion,
        details: { problems: chain.problems },
        startedAt,
        finishedAt,
      });
      return Promise.resolve();
    });

    this.metrics.reconciliationRun('wallet', consistent);
    if (!consistent) {
      this.metrics.reconciliationMismatch('wallet');
      this.logger.error('wallet reconciliation found a divergence', {
        correlationId: command.correlationId,
        walletId: snapshot.walletId,
        ...(chain.firstDivergentVersion === undefined
          ? {}
          : { firstDivergentVersion: chain.firstDivergentVersion }),
        problems: chain.problems,
      });
    }

    return {
      walletId: snapshot.walletId,
      storedBalance,
      calculatedBalance,
      difference,
      consistent,
      checkedEntries: snapshot.entries,
      chain: {
        valid: chain.valid,
        firstDivergentVersion: chain.firstDivergentVersion,
        problems: chain.problems,
      },
      runId,
      checkedAt: finishedAt,
    };
  }
}
