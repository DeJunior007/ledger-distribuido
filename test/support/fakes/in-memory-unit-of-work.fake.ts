import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import type { ClockPort } from '@application/ports/clock.port';
import type { PendingReferenceRetry } from '@application/ports/repositories/pending-reference-repository.port';
import type { ReconciliationRunInput } from '@application/ports/repositories/reconciliation-repository.port';
import {
  UnitOfWorkPort,
  type ReadRepositories,
  type Repositories,
  type TransactionKind,
} from '@application/ports/unit-of-work.port';
import type { IdempotencyRecordState } from '@domain/idempotency/idempotency-record';
import type { InboxMessageState } from '@domain/messaging/inbox-message';
import type { OutboxMessageState } from '@domain/messaging/outbox-message';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import type { WagerTransactionState } from '@domain/wagering/wager-transaction';
import { WagerTransactionStatus } from '@domain/wagering/wager-transaction-status';
import type { HouseAccountState } from '@domain/wallet/house-account';
import type { HouseLedgerEntryState } from '@domain/wallet/house-ledger-entry';
import type { WalletLedgerEntryState } from '@domain/wallet/wallet-ledger-entry';
import type { WalletState } from '@domain/wallet/wallet';
import { InMemoryHouseAccountRepository } from './house-account.fake';
import { InMemoryIdempotencyRepository } from './idempotency.fake';
import { InMemoryInboxRepository } from './inbox.fake';
import { InMemoryLedgerRepository } from './ledger.fake';
import { InMemoryOutboxRepository } from './outbox.fake';
import { InMemoryPendingReferenceRepository } from './pending-reference.fake';
import { InMemoryReconciliationRepository } from './reconciliation.fake';
import { InMemoryScheduledJobRepository } from './scheduled-job.fake';
import { InMemoryWagerTransactionRepository } from './wager-transaction.fake';
import { InMemoryWalletRepository } from './wallet.fake';

export const settle = <T>(compute: () => T): Promise<T> =>
  new Promise<T>((resolve) => {
    resolve(compute());
  });

export const compositeKey = (...parts: readonly string[]): string => JSON.stringify(parts);

type ConstraintClass = ErrorClass.Race | ErrorClass.Deterministic;

export const constraintViolation = (
  errorClass: ConstraintClass,
  constraint: string,
): TechnicalError =>
  new TechnicalError(errorClass, errorClass === ErrorClass.Race ? 'race' : 'deterministic', {
    constraint,
  });

export const missingRow = (table: string): TechnicalError =>
  new TechnicalError(ErrorClass.Deterministic, 'deterministic', { constraint: `${table}_pkey` });

export interface ScheduledJobState {
  name: string;
  lockedUntil: Date | undefined;
  lockedBy: string | undefined;
  lastRunAt: Date | undefined;
}

export interface UniqueRule<S> {
  readonly constraint: string;
  readonly errorClass: ConstraintClass;
  readonly valueOf: (row: S) => string | undefined;
}

export interface TableDefinition<S> {
  readonly name: string;
  readonly primaryKeyClass: ConstraintClass;
  readonly keyOf: (row: S) => string;
  readonly uniques: readonly UniqueRule<S>[];
}

export class FakeTable<S extends object> {
  private readonly stored = new Map<string, S>();

  constructor(readonly definition: TableDefinition<S>) {}

  get(key: string): S | undefined {
    const row = this.stored.get(key);
    return row === undefined ? undefined : { ...row };
  }

  entries(): [string, S][] {
    return [...this.stored].map(([key, row]): [string, S] => [key, { ...row }]);
  }

  rows(): S[] {
    return [...this.stored.values()].map((row) => ({ ...row }));
  }

  put(row: S): void {
    this.stored.set(this.definition.keyOf(row), { ...row });
  }
}

export interface WriteSet {
  flush(): void;
  validateCommit(): void;
  apply(): void;
}

export class TableWrites<S extends object> implements WriteSet {
  private readonly written = new Map<string, S>();
  private readonly inserted = new Set<string>();
  private readonly dirty = new Set<string>();

  constructor(private readonly table: FakeTable<S>) {}

  find(key: string): S | undefined {
    const own = this.written.get(key);
    return own === undefined ? this.table.get(key) : { ...own };
  }

  rows(): S[] {
    return [...this.view().values()].map((row) => ({ ...row }));
  }

  insert(row: S): void {
    const key = this.table.definition.keyOf(row);
    if (this.written.has(key)) {
      throw this.primaryKeyViolation();
    }
    this.written.set(key, { ...row });
    this.inserted.add(key);
    this.dirty.add(key);
  }

  update(row: S): void {
    const key = this.table.definition.keyOf(row);
    if (this.find(key) === undefined) {
      throw missingRow(this.table.definition.name);
    }
    this.written.set(key, { ...row });
    this.dirty.add(key);
  }

  flush(): void {
    this.validate([...this.dirty]);
    this.dirty.clear();
  }

  validateCommit(): void {
    this.validate([...this.written.keys()]);
  }

  apply(): void {
    for (const row of this.written.values()) {
      this.table.put(row);
    }
  }

  private view(): Map<string, S> {
    const merged = new Map(this.table.entries());
    for (const [key, row] of this.written) {
      merged.set(key, row);
    }
    return merged;
  }

  private primaryKeyViolation(): TechnicalError {
    const { name, primaryKeyClass } = this.table.definition;
    return constraintViolation(primaryKeyClass, `${name}_pkey`);
  }

  private validate(keys: readonly string[]): void {
    const view = this.view();
    for (const key of keys) {
      const row = this.written.get(key);
      if (row === undefined) {
        continue;
      }
      if (this.inserted.has(key) && this.table.get(key) !== undefined) {
        throw this.primaryKeyViolation();
      }
      for (const unique of this.table.definition.uniques) {
        const value = unique.valueOf(row);
        if (value === undefined) {
          continue;
        }
        for (const [otherKey, other] of view) {
          if (otherKey !== key && unique.valueOf(other) === value) {
            throw constraintViolation(unique.errorClass, unique.constraint);
          }
        }
      }
    }
  }
}

interface LockWaiter {
  readonly owner: number;
  readonly resume: () => void;
}

export class KeyedLocks {
  private readonly holders = new Map<string, number>();
  private readonly waiters = new Map<string, LockWaiter[]>();

  tryAcquire(key: string, owner: number): boolean {
    const holder = this.holders.get(key);
    if (holder === undefined) {
      this.holders.set(key, owner);
      return true;
    }
    return holder === owner;
  }

  async acquire(key: string, owner: number): Promise<boolean> {
    if (this.tryAcquire(key, owner)) {
      return false;
    }
    await new Promise<void>((resume) => {
      const queue = this.waiters.get(key) ?? [];
      queue.push({ owner, resume });
      this.waiters.set(key, queue);
    });
    return true;
  }

  releaseAll(owner: number): void {
    for (const [key, holder] of [...this.holders]) {
      if (holder !== owner) {
        continue;
      }
      const next = this.waiters.get(key)?.shift();
      if (next === undefined) {
        this.holders.delete(key);
        this.waiters.delete(key);
        continue;
      }
      this.holders.set(key, next.owner);
      next.resume();
    }
  }
}

const isProcessedReversal = (row: WagerTransactionState): boolean =>
  (row.kind === WagerTransactionKind.Refund || row.kind === WagerTransactionKind.Rollback) &&
  row.status === WagerTransactionStatus.Processed;

export class InMemoryDatabase {
  readonly locks = new KeyedLocks();

  readonly wallets = new FakeTable<WalletState>({
    name: 'wallets',
    primaryKeyClass: ErrorClass.Deterministic,
    keyOf: (row) => row.id,
    uniques: [
      {
        constraint: 'wallets_player_currency_uq',
        errorClass: ErrorClass.Race,
        valueOf: (row) => compositeKey(row.playerId, row.currency),
      },
    ],
  });

  readonly houseAccounts = new FakeTable<HouseAccountState>({
    name: 'house_accounts',
    primaryKeyClass: ErrorClass.Deterministic,
    keyOf: (row) => row.id,
    uniques: [
      {
        constraint: 'house_accounts_currency_purpose_uq',
        errorClass: ErrorClass.Deterministic,
        valueOf: (row) => compositeKey(row.currency, row.purpose),
      },
    ],
  });

  readonly transactions = new FakeTable<WagerTransactionState>({
    name: 'wager_transactions',
    primaryKeyClass: ErrorClass.Deterministic,
    keyOf: (row) => row.id,
    uniques: [
      {
        constraint: 'wager_transactions_provider_external_uq',
        errorClass: ErrorClass.Race,
        valueOf: (row) => compositeKey(row.providerId, row.externalTransactionId),
      },
      {
        constraint: 'wager_transactions_provider_key_uq',
        errorClass: ErrorClass.Race,
        valueOf: (row) => compositeKey(row.providerId, row.idempotencyKey),
      },
      {
        constraint: 'wager_transactions_single_opening_uq',
        errorClass: ErrorClass.Deterministic,
        valueOf: (row) => (row.kind === WagerTransactionKind.Opening ? row.walletId : undefined),
      },
      {
        constraint: 'wager_transactions_single_reversal_uq',
        errorClass: ErrorClass.Race,
        valueOf: (row) => (isProcessedReversal(row) ? row.referenceTransactionId : undefined),
      },
    ],
  });

  readonly walletEntries = new FakeTable<WalletLedgerEntryState>({
    name: 'ledger_entries',
    primaryKeyClass: ErrorClass.Deterministic,
    keyOf: (row) => row.id,
    uniques: [
      {
        constraint: 'ledger_entries_one_per_wallet_uq',
        errorClass: ErrorClass.Deterministic,
        valueOf: (row) => compositeKey(row.transactionId, row.walletId),
      },
      {
        constraint: 'ledger_entries_wallet_version_uq',
        errorClass: ErrorClass.Deterministic,
        valueOf: (row) => compositeKey(row.walletId, String(row.walletVersion)),
      },
    ],
  });

  readonly houseEntries = new FakeTable<HouseLedgerEntryState>({
    name: 'ledger_entries',
    primaryKeyClass: ErrorClass.Deterministic,
    keyOf: (row) => row.id,
    uniques: [
      {
        constraint: 'ledger_entries_one_house_per_tx_uq',
        errorClass: ErrorClass.Deterministic,
        valueOf: (row) => row.transactionId,
      },
    ],
  });

  readonly idempotency = new FakeTable<IdempotencyRecordState>({
    name: 'idempotency_records',
    primaryKeyClass: ErrorClass.Race,
    keyOf: (row) => compositeKey(row.providerId, row.idempotencyKey),
    uniques: [],
  });

  readonly inbox = new FakeTable<InboxMessageState>({
    name: 'inbox_messages',
    primaryKeyClass: ErrorClass.Race,
    keyOf: (row) => compositeKey(row.consumerName, row.messageId),
    uniques: [],
  });

  readonly outbox = new FakeTable<OutboxMessageState>({
    name: 'outbox_messages',
    primaryKeyClass: ErrorClass.Deterministic,
    keyOf: (row) => row.id,
    uniques: [],
  });

  readonly pendingReferences = new FakeTable<PendingReferenceRetry>({
    name: 'pending_reference_retries',
    primaryKeyClass: ErrorClass.Deterministic,
    keyOf: (row) => row.transactionId,
    uniques: [],
  });

  readonly scheduledJobs = new FakeTable<ScheduledJobState>({
    name: 'scheduled_jobs',
    primaryKeyClass: ErrorClass.Deterministic,
    keyOf: (row) => row.name,
    uniques: [],
  });

  readonly reconciliationRuns = new FakeTable<ReconciliationRunInput>({
    name: 'reconciliation_runs',
    primaryKeyClass: ErrorClass.Deterministic,
    keyOf: (row) => row.id,
    uniques: [],
  });

  private sequence = 0;

  constructor(readonly clock: ClockPort) {
    this.scheduledJobs.put({
      name: 'global-reconciliation',
      lockedUntil: undefined,
      lockedBy: undefined,
      lastRunAt: undefined,
    });
  }

  begin(): FakeTransaction {
    this.sequence += 1;
    return new FakeTransaction(this.sequence, this);
  }
}

export class FakeTransaction {
  readonly wallets: TableWrites<WalletState>;
  readonly houseAccounts: TableWrites<HouseAccountState>;
  readonly transactions: TableWrites<WagerTransactionState>;
  readonly walletEntries: TableWrites<WalletLedgerEntryState>;
  readonly houseEntries: TableWrites<HouseLedgerEntryState>;
  readonly idempotency: TableWrites<IdempotencyRecordState>;
  readonly inbox: TableWrites<InboxMessageState>;
  readonly outbox: TableWrites<OutboxMessageState>;
  readonly pendingReferences: TableWrites<PendingReferenceRetry>;
  readonly scheduledJobs: TableWrites<ScheduledJobState>;
  readonly reconciliationRuns: TableWrites<ReconciliationRunInput>;
  private readonly writeSets: readonly WriteSet[];
  private readonly flushHooks: (() => void)[] = [];
  private readonly commitChecks: (() => void)[] = [];

  constructor(
    readonly id: number,
    readonly database: InMemoryDatabase,
  ) {
    this.wallets = new TableWrites(database.wallets);
    this.houseAccounts = new TableWrites(database.houseAccounts);
    this.transactions = new TableWrites(database.transactions);
    this.walletEntries = new TableWrites(database.walletEntries);
    this.houseEntries = new TableWrites(database.houseEntries);
    this.idempotency = new TableWrites(database.idempotency);
    this.inbox = new TableWrites(database.inbox);
    this.outbox = new TableWrites(database.outbox);
    this.pendingReferences = new TableWrites(database.pendingReferences);
    this.scheduledJobs = new TableWrites(database.scheduledJobs);
    this.reconciliationRuns = new TableWrites(database.reconciliationRuns);
    this.writeSets = [
      this.wallets,
      this.houseAccounts,
      this.transactions,
      this.walletEntries,
      this.houseEntries,
      this.idempotency,
      this.inbox,
      this.outbox,
      this.pendingReferences,
      this.scheduledJobs,
      this.reconciliationRuns,
    ];
  }

  onFlush(hook: () => void): void {
    this.flushHooks.push(hook);
  }

  onCommit(check: () => void): void {
    this.commitChecks.push(check);
  }

  flush(): void {
    for (const hook of this.flushHooks) {
      hook();
    }
    for (const writeSet of this.writeSets) {
      writeSet.flush();
    }
  }

  commit(): void {
    this.flush();
    for (const check of this.commitChecks) {
      check();
    }
    for (const writeSet of this.writeSets) {
      writeSet.validateCommit();
    }
    for (const writeSet of this.writeSets) {
      writeSet.apply();
    }
  }

  release(): void {
    this.database.locks.releaseAll(this.id);
  }
}

export class InMemoryUnitOfWork extends UnitOfWorkPort {
  readonly database: InMemoryDatabase;
  private readonly commitInterceptors: (() => Promise<void>)[] = [];

  constructor(clock: ClockPort) {
    super();
    this.database = new InMemoryDatabase(clock);
  }

  interceptNextCommit(interceptor: () => Promise<void>): void {
    this.commitInterceptors.push(interceptor);
  }

  async run<T>(kind: TransactionKind, work: (repos: Repositories) => Promise<T>): Promise<T> {
    const transaction = this.database.begin();
    try {
      const result = await work(this.repositoriesFor(transaction));
      transaction.flush();
      const interceptor = this.commitInterceptors.shift();
      if (interceptor !== undefined) {
        await interceptor();
      }
      transaction.commit();
      return result;
    } finally {
      transaction.release();
    }
  }

  async read<T>(work: (repos: ReadRepositories) => Promise<T>): Promise<T> {
    const transaction = this.database.begin();
    try {
      const { wallets, transactions, ledger, idempotency, inbox } =
        this.repositoriesFor(transaction);
      return await work({ wallets, transactions, ledger, idempotency, inbox });
    } finally {
      transaction.release();
    }
  }

  private repositoriesFor(transaction: FakeTransaction): Repositories {
    return {
      wallets: new InMemoryWalletRepository(transaction),
      houseAccounts: new InMemoryHouseAccountRepository(transaction),
      transactions: new InMemoryWagerTransactionRepository(transaction),
      ledger: new InMemoryLedgerRepository(transaction),
      idempotency: new InMemoryIdempotencyRepository(transaction),
      inbox: new InMemoryInboxRepository(transaction),
      outbox: new InMemoryOutboxRepository(transaction),
      pendingReferences: new InMemoryPendingReferenceRepository(transaction),
      scheduledJobs: new InMemoryScheduledJobRepository(transaction),
      reconciliation: new InMemoryReconciliationRepository(transaction),
      flush: () =>
        settle(() => {
          transaction.flush();
        }),
    };
  }
}
