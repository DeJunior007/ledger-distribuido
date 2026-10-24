import { WalletEntitySchema } from './wallets.entity-schema';
import { HouseAccountEntitySchema } from './house-accounts.entity-schema';
import { WagerTransactionEntitySchema } from './wager-transactions.entity-schema';
import { LedgerEntryEntitySchema } from './ledger-entries.entity-schema';
import { IdempotencyRecordEntitySchema } from './idempotency-records.entity-schema';
import { InboxMessageEntitySchema } from './inbox-messages.entity-schema';
import { OutboxMessageEntitySchema } from './outbox-messages.entity-schema';
import { PendingReferenceRetryEntitySchema } from './pending-reference-retries.entity-schema';
import { ScheduledJobEntitySchema } from './scheduled-jobs.entity-schema';
import { ReconciliationRunEntitySchema } from './reconciliation-runs.entity-schema';

export const ENTITY_SCHEMAS = [
  WalletEntitySchema,
  HouseAccountEntitySchema,
  WagerTransactionEntitySchema,
  LedgerEntryEntitySchema,
  IdempotencyRecordEntitySchema,
  InboxMessageEntitySchema,
  OutboxMessageEntitySchema,
  PendingReferenceRetryEntitySchema,
  ScheduledJobEntitySchema,
  ReconciliationRunEntitySchema,
];
