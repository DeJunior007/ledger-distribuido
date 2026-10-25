import type { EntityManager } from '@mikro-orm/postgresql';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import type { WagerTransactionRepositoryPort } from '@application/ports/repositories/wager-transaction-repository.port';
import type { WagerTransaction } from '@domain/wagering/wager-transaction';
import * as wagerTransactionMapper from '../mappers/wager-transaction.mapper';
import { corruptedRow } from '../mappers/persisted-values.mapper';
import { WagerTransactionRecord } from '../records/wager-transactions.record';
import { processedWinRowsSchema, reversedRowsSchema } from '../rows/wager-transactions.row';

const IS_REVERSED_SQL = `SELECT EXISTS (SELECT 1 FROM wager_transactions WHERE reference_transaction_id = ? AND kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED') AS reversed`;

const HAS_PROCESSED_WIN_IN_ROUND_SQL = `SELECT EXISTS (SELECT 1 FROM wager_transactions WHERE wallet_id = ? AND round_id = ? AND kind = 'WIN' AND status = 'PROCESSED') AS found`;

const unmanagedTransaction = (): TechnicalError =>
  new TechnicalError(ErrorClass.Deterministic, 'deterministic');

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async findById(
    id: string,
    options?: { refresh?: boolean },
  ): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, id, {
      refresh: options?.refresh === true,
    });
    return record === null ? undefined : wagerTransactionMapper.toDomain(record);
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
    options?: { refresh?: boolean },
  ): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(
      WagerTransactionRecord,
      { providerId, externalTransactionId },
      { refresh: options?.refresh === true },
    );
    return record === null ? undefined : wagerTransactionMapper.toDomain(record);
  }

  async isReversed(transactionId: string): Promise<boolean> {
    const parsed = reversedRowsSchema.safeParse(
      await this.em.execute(IS_REVERSED_SQL, [transactionId]),
    );
    if (!parsed.success) {
      throw corruptedRow();
    }
    return parsed.data[0].reversed;
  }

  async hasProcessedWinInRound(walletId: string, roundId: string): Promise<boolean> {
    const parsed = processedWinRowsSchema.safeParse(
      await this.em.execute(HAS_PROCESSED_WIN_IN_ROUND_SQL, [walletId, roundId]),
    );
    if (!parsed.success) {
      throw corruptedRow();
    }
    return parsed.data[0].found;
  }

  insert(transaction: WagerTransaction): void {
    this.em.persist(wagerTransactionMapper.toRecord(transaction));
  }

  update(transaction: WagerTransaction): void {
    const existing = this.managedRecord(transaction.id);
    if (existing === undefined) {
      throw unmanagedTransaction();
    }
    this.em.persist(wagerTransactionMapper.toRecord(transaction, existing));
  }

  private managedRecord(id: string): WagerTransactionRecord | undefined {
    return (
      this.em.getUnitOfWork().tryGetById<WagerTransactionRecord>(WagerTransactionRecord.name, id) ??
      undefined
    );
  }
}
