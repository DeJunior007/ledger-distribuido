import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import {
  WalletRepositoryPort,
  type LockedWallet,
} from '@application/ports/repositories/wallet-repository.port';
import { Wallet, type WalletState } from '@domain/wallet/wallet';
import { compositeKey, missingRow, settle } from './in-memory-unit-of-work.fake';
import type { FakeTransaction } from './in-memory-unit-of-work.fake';

const versionMismatch = (): TechnicalError =>
  new TechnicalError(ErrorClass.Transient, 'version_mismatch');

export class InMemoryWalletRepository extends WalletRepositoryPort {
  private readonly persistedVersions = new Map<string, number>();
  private readonly committedBaselines = new Map<string, number>();
  private readonly insertedIds = new Set<string>();
  private readonly pendingInserts = new Map<string, WalletState>();
  private readonly pendingUpdates = new Map<string, WalletState>();

  constructor(private readonly transaction: FakeTransaction) {
    super();
    transaction.onFlush(() => {
      this.flushPending();
    });
    transaction.onCommit(() => {
      this.checkCommittedVersions();
    });
  }

  async lockById(id: string): Promise<LockedWallet | undefined> {
    const startedAt = performance.now();
    this.flushPending();
    if (this.transaction.wallets.find(id) === undefined) {
      return undefined;
    }
    const contended = await this.transaction.database.locks.acquire(
      compositeKey('wallets', id),
      this.transaction.id,
    );
    const wallet = this.load(id);
    if (wallet === undefined) {
      return undefined;
    }
    return { wallet, contended, waitSeconds: (performance.now() - startedAt) / 1000 };
  }

  findById(id: string): Promise<Wallet | undefined> {
    return settle(() => {
      this.flushPending();
      return this.load(id);
    });
  }

  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    return settle(() => {
      this.flushPending();
      const row = this.transaction.wallets
        .rows()
        .find((candidate) => candidate.playerId === playerId && candidate.currency === currency);
      return row === undefined ? undefined : this.load(row.id);
    });
  }

  insert(wallet: Wallet): void {
    this.pendingInserts.set(wallet.id, wallet.toState());
  }

  update(wallet: Wallet): void {
    if (this.pendingInserts.has(wallet.id)) {
      this.pendingInserts.set(wallet.id, wallet.toState());
      return;
    }
    this.pendingUpdates.set(wallet.id, wallet.toState());
  }

  assertPersistedVersion(wallet: Wallet): Promise<void> {
    return settle(() => {
      if (this.persistedVersions.get(wallet.id) !== wallet.version) {
        throw new TechnicalError(ErrorClass.Deterministic, 'wallet_version_drift');
      }
    });
  }

  private load(id: string): Wallet | undefined {
    const row = this.transaction.wallets.find(id);
    if (row === undefined) {
      return undefined;
    }
    this.persistedVersions.set(id, row.version);
    return Wallet.rehydrate(row);
  }

  private flushPending(): void {
    for (const [id, state] of this.pendingInserts) {
      this.transaction.wallets.insert({ ...state, version: 1 });
      this.persistedVersions.set(id, 1);
      this.insertedIds.add(id);
    }
    this.pendingInserts.clear();
    for (const [id, state] of this.pendingUpdates) {
      const current = this.transaction.wallets.find(id);
      if (current === undefined) {
        throw missingRow('wallets');
      }
      const base = this.persistedVersions.get(id) ?? current.version;
      if (current.version !== base) {
        throw versionMismatch();
      }
      if (!this.insertedIds.has(id) && !this.committedBaselines.has(id)) {
        this.committedBaselines.set(id, base);
      }
      this.transaction.wallets.update({ ...state, version: base + 1 });
      this.persistedVersions.set(id, base + 1);
    }
    this.pendingUpdates.clear();
  }

  private checkCommittedVersions(): void {
    for (const [id, baseline] of this.committedBaselines) {
      if (this.transaction.database.wallets.get(id)?.version !== baseline) {
        throw versionMismatch();
      }
    }
  }
}
