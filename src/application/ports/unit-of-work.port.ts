import type { HouseAccountRepositoryPort } from './repositories/house-account-repository.port';
import type { IdempotencyRepositoryPort } from './repositories/idempotency-repository.port';
import type { InboxRepositoryPort } from './repositories/inbox-repository.port';
import type { LedgerRepositoryPort } from './repositories/ledger-repository.port';
import type { OutboxRepositoryPort } from './repositories/outbox-repository.port';
import type { PendingReferenceRepositoryPort } from './repositories/pending-reference-repository.port';
import type { ReconciliationRepositoryPort } from './repositories/reconciliation-repository.port';
import type { ScheduledJobRepositoryPort } from './repositories/scheduled-job-repository.port';
import type { WagerTransactionRepositoryPort } from './repositories/wager-transaction-repository.port';
import type { WalletRepositoryPort } from './repositories/wallet-repository.port';

export type TransactionKind = 'write' | 'short' | 'reconciliation';

export interface Repositories {
  wallets: WalletRepositoryPort;
  houseAccounts: HouseAccountRepositoryPort;
  transactions: WagerTransactionRepositoryPort;
  ledger: LedgerRepositoryPort;
  idempotency: IdempotencyRepositoryPort;
  inbox: InboxRepositoryPort;
  outbox: OutboxRepositoryPort;
  pendingReferences: PendingReferenceRepositoryPort;
  scheduledJobs: ScheduledJobRepositoryPort;
  reconciliation: ReconciliationRepositoryPort;
  flush(): Promise<void>;
}

export type ReadRepositories = Pick<
  Repositories,
  'wallets' | 'transactions' | 'ledger' | 'idempotency' | 'inbox'
>;

export abstract class UnitOfWorkPort {
  abstract run<T>(kind: TransactionKind, work: (repos: Repositories) => Promise<T>): Promise<T>;
  abstract read<T>(work: (repos: ReadRepositories) => Promise<T>): Promise<T>;
}
