import { DriverException, LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { z } from 'zod';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import type {
  LockedWallet,
  WalletRepositoryPort,
} from '@application/ports/repositories/wallet-repository.port';
import type { Wallet } from '@domain/wallet/wallet';
import * as walletMapper from '../mappers/wallet.mapper';
import { corruptedRow } from '../mappers/persisted-values.mapper';
import { WalletRecord } from '../records/wallets.record';
import { walletVersionRowSchema } from '../rows/wallets.row';

const LOCK_NOT_AVAILABLE = '55P03';

const PERSISTED_VERSION_SQL = 'SELECT version FROM wallets WHERE id = ?';

const persistedVersionRowsSchema = z.array(walletVersionRowSchema);

const isLockNotAvailable = (error: unknown): boolean =>
  error instanceof DriverException && error.code === LOCK_NOT_AVAILABLE;

const versionDrift = (): TechnicalError =>
  new TechnicalError(ErrorClass.Deterministic, 'wallet_version_drift');

const unmanagedWallet = (): TechnicalError =>
  new TechnicalError(ErrorClass.Deterministic, 'deterministic');

interface LockAttempt {
  readonly record: WalletRecord | null;
  readonly contended: boolean;
}

export class MikroOrmWalletRepository implements WalletRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async lockById(id: string): Promise<LockedWallet | undefined> {
    const startedAt = performance.now();
    await this.em.execute('SAVEPOINT wallet_lock');
    const attempt = await this.lockWithinSavepoint(id);
    await this.em.execute('RELEASE SAVEPOINT wallet_lock');
    const waitSeconds = (performance.now() - startedAt) / 1000;
    if (attempt.record === null) {
      return undefined;
    }
    return {
      wallet: walletMapper.toDomain(attempt.record),
      contended: attempt.contended,
      waitSeconds,
    };
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, id);
    return record === null ? undefined : walletMapper.toDomain(record);
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { playerId, currency });
    return record === null ? undefined : walletMapper.toDomain(record);
  }

  insert(wallet: Wallet): void {
    this.em.persist(walletMapper.toRecord(wallet));
  }

  update(wallet: Wallet): void {
    const existing = this.managedRecord(wallet.id);
    if (existing === undefined) {
      throw unmanagedWallet();
    }
    this.em.persist(walletMapper.toRecord(wallet, existing));
  }

  async assertPersistedVersion(wallet: Wallet): Promise<void> {
    const parsed = persistedVersionRowsSchema.safeParse(
      await this.em.execute(PERSISTED_VERSION_SQL, [wallet.id]),
    );
    if (!parsed.success) {
      throw corruptedRow();
    }
    const persisted = parsed.data[0];
    const record = this.managedRecord(wallet.id);
    if (persisted?.version !== wallet.version || record?.version !== wallet.version) {
      throw versionDrift();
    }
  }

  private async lockWithinSavepoint(id: string): Promise<LockAttempt> {
    try {
      const record = await this.em.findOne(WalletRecord, id, {
        lockMode: LockMode.PESSIMISTIC_WRITE_OR_FAIL,
        refresh: true,
      });
      return { record, contended: false };
    } catch (error) {
      if (!isLockNotAvailable(error)) {
        throw error;
      }
    }
    await this.em.execute('ROLLBACK TO SAVEPOINT wallet_lock');
    const record = await this.em.findOne(WalletRecord, id, {
      lockMode: LockMode.PESSIMISTIC_WRITE,
      refresh: true,
    });
    return { record, contended: true };
  }

  private managedRecord(id: string): WalletRecord | undefined {
    return this.em.getUnitOfWork().getById<WalletRecord>(WalletRecord.name, id);
  }
}
