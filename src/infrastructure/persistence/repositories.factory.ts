import type { EntityManager } from '@mikro-orm/postgresql';
import type { Repositories } from '@application/ports/unit-of-work.port';
import { MikroOrmHouseAccountRepository } from './repositories/house-account.repository';
import { MikroOrmIdempotencyRepository } from './repositories/idempotency.repository';
import { MikroOrmInboxRepository } from './repositories/inbox.repository';
import { MikroOrmLedgerRepository } from './repositories/ledger.repository';
import { MikroOrmOutboxRepository } from './repositories/outbox.repository';
import { MikroOrmPendingReferenceRepository } from './repositories/pending-reference.repository';
import { MikroOrmReconciliationRepository } from './repositories/reconciliation.repository';
import { MikroOrmScheduledJobRepository } from './repositories/scheduled-job.repository';
import { MikroOrmWagerTransactionRepository } from './repositories/wager-transaction.repository';
import { MikroOrmWalletRepository } from './repositories/wallet.repository';

export const createRepositories = (em: EntityManager): Repositories => ({
  wallets: new MikroOrmWalletRepository(em),
  houseAccounts: new MikroOrmHouseAccountRepository(em),
  transactions: new MikroOrmWagerTransactionRepository(em),
  ledger: new MikroOrmLedgerRepository(em),
  idempotency: new MikroOrmIdempotencyRepository(em),
  inbox: new MikroOrmInboxRepository(em),
  outbox: new MikroOrmOutboxRepository(em),
  pendingReferences: new MikroOrmPendingReferenceRepository(em),
  scheduledJobs: new MikroOrmScheduledJobRepository(em),
  reconciliation: new MikroOrmReconciliationRepository(em),
  flush: () => em.flush(),
});
