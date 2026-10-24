import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Client, DatabaseError } from 'pg';
import type { QueryConfig } from 'pg';
import { registerCurrentDatabase } from '@test/support/current-database';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';

type Row = Readonly<Record<string, string | number | boolean | null>>;

interface ConstraintCase {
  readonly constraint: string;
  readonly code: string;
  readonly setup: readonly QueryConfig[];
  readonly violation: QueryConfig;
}

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';

const PLAYER_ID = '0196b000-0000-7000-8000-000000000001';
const OTHER_PLAYER_ID = '0196b000-0000-7000-8000-000000000002';
const WALLET_ID = '0196b000-0000-7000-8000-000000000010';
const OTHER_WALLET_ID = '0196b000-0000-7000-8000-000000000011';
const HOUSE_ID = '0196b000-0000-7000-8000-000000000020';
const OTHER_HOUSE_ID = '0196b000-0000-7000-8000-000000000021';
const TX_ID = '0196b000-0000-7000-8000-000000000030';
const SECOND_TX_ID = '0196b000-0000-7000-8000-000000000031';
const THIRD_TX_ID = '0196b000-0000-7000-8000-000000000032';
const ENTRY_ID = '0196b000-0000-7000-8000-000000000040';
const SECOND_ENTRY_ID = '0196b000-0000-7000-8000-000000000041';
const OUTBOX_ID = '0196b000-0000-7000-8000-000000000050';
const RUN_ID = '0196b000-0000-7000-8000-000000000060';
const HASH = 'a'.repeat(64);
const NOW = '2026-10-24T12:00:00.000Z';
const LATER = '2026-10-24T12:05:00.000Z';
const SYSTEM_PROVIDER = '__system__';

const insert = (table: string, row: Row): QueryConfig => {
  const columns = Object.keys(row);
  const placeholders = columns.map((_, index) => `$${String(index + 1)}`);
  return {
    text: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
    values: Object.values(row),
  };
};

const wallet = (overrides: Row = {}): Row => ({
  id: WALLET_ID,
  player_id: PLAYER_ID,
  currency: 'BRL',
  balance: '0.00',
  version: 1,
  created_at: NOW,
  updated_at: NOW,
  ...overrides,
});

const houseAccount = (overrides: Row = {}): Row => ({
  id: HOUSE_ID,
  currency: 'BRL',
  purpose: 'GAMING',
  created_at: NOW,
  ...overrides,
});

const transaction = (id: string, externalId: string, overrides: Row = {}): Row => ({
  id,
  provider_id: 'provider-a',
  external_transaction_id: externalId,
  idempotency_key: `key-${externalId}`,
  payload_hash: HASH,
  wallet_id: WALLET_ID,
  player_id: PLAYER_ID,
  round_id: 'round-1',
  game_id: 'game-1',
  kind: 'BET',
  amount: '10.00',
  currency: 'BRL',
  reference_external_transaction_id: null,
  reference_transaction_id: null,
  status: 'PROCESSED',
  failure_code: null,
  balance_snapshot_amount: null,
  balance_snapshot_currency: null,
  correlation_id: `corr-${externalId}`,
  created_at: NOW,
  processed_at: NOW,
  updated_at: NOW,
  ...overrides,
});

const rejected = (failureCode: string | null): Row => ({
  status: 'REJECTED',
  failure_code: failureCode,
  processed_at: null,
});

const walletEntry = (overrides: Row = {}): Row => ({
  id: ENTRY_ID,
  transaction_id: TX_ID,
  account_kind: 'WALLET',
  wallet_id: WALLET_ID,
  house_account_id: null,
  direction: 'CREDIT',
  amount: '10.00',
  currency: 'BRL',
  balance_before: '0.00',
  balance_after: '10.00',
  wallet_version: 1,
  created_at: NOW,
  ...overrides,
});

const houseEntry = (overrides: Row = {}): Row => ({
  id: ENTRY_ID,
  transaction_id: TX_ID,
  account_kind: 'HOUSE',
  wallet_id: null,
  house_account_id: HOUSE_ID,
  direction: 'DEBIT',
  amount: '10.00',
  currency: 'BRL',
  balance_before: null,
  balance_after: null,
  wallet_version: null,
  created_at: NOW,
  ...overrides,
});

const idempotencyRecord = (overrides: Row = {}): Row => ({
  provider_id: 'provider-a',
  idempotency_key: 'key-1',
  payload_hash: HASH,
  transaction_id: null,
  http_status: 200,
  response_body: '{}',
  created_at: NOW,
  updated_at: NOW,
  ...overrides,
});

const inboxMessage = (overrides: Row = {}): Row => ({
  consumer_name: 'wager-transactions-consumer',
  message_id: 'message-1',
  payload_hash: HASH,
  received_at: NOW,
  processed_at: null,
  ...overrides,
});

const outboxMessage = (overrides: Row = {}): Row => ({
  id: OUTBOX_ID,
  aggregate_id: WALLET_ID,
  event_type: 'WalletBalanceChanged',
  payload: '{}',
  occurred_at: NOW,
  next_attempt_at: NOW,
  ...overrides,
});

const pendingRetry = (overrides: Row = {}): Row => ({
  transaction_id: TX_ID,
  next_attempt_at: NOW,
  deadline_at: LATER,
  created_at: NOW,
  ...overrides,
});

const reconciliationRun = (overrides: Row = {}): Row => ({
  id: RUN_ID,
  scope: 'GLOBAL',
  wallet_id: null,
  consistent: true,
  checked_entries: 0,
  details: '{}',
  started_at: NOW,
  finished_at: LATER,
  ...overrides,
});

const baseWallet = insert('wallets', wallet());
const baseHouse = insert('house_accounts', houseAccount());
const baseBet = insert('wager_transactions', transaction(TX_ID, 'ext-1'));
const ledgerSetup = [baseWallet, baseHouse, baseBet];

const check = (
  constraint: string,
  violation: QueryConfig,
  setup: readonly QueryConfig[] = [],
): ConstraintCase => ({ constraint, code: CHECK_VIOLATION, setup, violation });

const unique = (
  constraint: string,
  setup: readonly QueryConfig[],
  violation: QueryConfig,
): ConstraintCase => ({ constraint, code: UNIQUE_VIOLATION, setup, violation });

const WALLET_CASES: readonly ConstraintCase[] = [
  unique('wallets_pkey', [baseWallet], insert('wallets', wallet({ player_id: OTHER_PLAYER_ID }))),
  unique(
    'wallets_player_currency_uq',
    [baseWallet],
    insert('wallets', wallet({ id: OTHER_WALLET_ID })),
  ),
  check('wallets_balance_non_negative_ck', insert('wallets', wallet({ balance: '-0.01' }))),
  check('wallets_version_positive_ck', insert('wallets', wallet({ version: 0 }))),
  check('wallets_currency_format_ck', insert('wallets', wallet({ currency: 'brl' }))),
];

const HOUSE_ACCOUNT_CASES: readonly ConstraintCase[] = [
  unique(
    'house_accounts_pkey',
    [baseHouse],
    insert('house_accounts', houseAccount({ currency: 'USD' })),
  ),
  unique(
    'house_accounts_currency_purpose_uq',
    [baseHouse],
    insert('house_accounts', houseAccount({ id: OTHER_HOUSE_ID })),
  ),
  check('house_accounts_purpose_ck', insert('house_accounts', houseAccount({ purpose: 'BONUS' }))),
  check(
    'house_accounts_currency_format_ck',
    insert('house_accounts', houseAccount({ currency: 'US1' })),
  ),
];

const transactionCheck = (constraint: string, overrides: Row): ConstraintCase =>
  check(constraint, insert('wager_transactions', transaction(TX_ID, 'ext-1', overrides)), [
    baseWallet,
  ]);

const WAGER_TRANSACTION_CASES: readonly ConstraintCase[] = [
  unique(
    'wager_transactions_pkey',
    [baseWallet, baseBet],
    insert('wager_transactions', transaction(TX_ID, 'ext-2')),
  ),
  unique(
    'wager_transactions_provider_external_uq',
    [baseWallet, baseBet],
    insert(
      'wager_transactions',
      transaction(SECOND_TX_ID, 'ext-1', { idempotency_key: 'key-other' }),
    ),
  ),
  unique(
    'wager_transactions_provider_key_uq',
    [baseWallet, baseBet],
    insert(
      'wager_transactions',
      transaction(SECOND_TX_ID, 'ext-2', { idempotency_key: 'key-ext-1' }),
    ),
  ),
  transactionCheck('wager_transactions_status_ck', { status: 'SETTLED', processed_at: null }),
  transactionCheck('wager_transactions_kind_ck', { kind: 'JACKPOT' }),
  transactionCheck('wager_transactions_system_provider_ck', { kind: 'OPENING' }),
  transactionCheck('wager_transactions_reference_required_ck', {
    kind: 'REFUND',
    ...rejected('REFERENCE_NOT_FOUND'),
  }),
  transactionCheck('wager_transactions_reference_allowed_ck', {
    reference_external_transaction_id: 'ext-0',
  }),
  transactionCheck('wager_transactions_reversal_resolved_ck', {
    kind: 'ROLLBACK',
    reference_external_transaction_id: 'ext-0',
  }),
  transactionCheck('wager_transactions_self_reference_ck', {
    kind: 'WIN',
    reference_external_transaction_id: 'ext-1',
  }),
  transactionCheck('wager_transactions_amount_ck', { amount: '0.00' }),
  transactionCheck('wager_transactions_failure_code_ck', rejected(null)),
  transactionCheck('wager_transactions_failed_code_ck', rejected('PROCESSING_FAILED')),
  transactionCheck('wager_transactions_failure_code_value_ck', rejected('UNKNOWN_FAILURE')),
  transactionCheck('wager_transactions_processed_at_ck', { processed_at: null }),
  transactionCheck('wager_transactions_currency_format_ck', { currency: 'BR' }),
  transactionCheck('wager_transactions_balance_snapshot_ck', {
    balance_snapshot_amount: '10.00',
  }),
  unique(
    'wager_transactions_single_opening_uq',
    [
      baseWallet,
      insert(
        'wager_transactions',
        transaction(TX_ID, 'opening-1', { provider_id: SYSTEM_PROVIDER, kind: 'OPENING' }),
      ),
    ],
    insert(
      'wager_transactions',
      transaction(SECOND_TX_ID, 'opening-2', { provider_id: SYSTEM_PROVIDER, kind: 'OPENING' }),
    ),
  ),
  unique(
    'wager_transactions_single_reversal_uq',
    [
      baseWallet,
      baseBet,
      insert(
        'wager_transactions',
        transaction(SECOND_TX_ID, 'ext-2', {
          kind: 'ROLLBACK',
          reference_external_transaction_id: 'ext-1',
          reference_transaction_id: TX_ID,
        }),
      ),
    ],
    insert(
      'wager_transactions',
      transaction(THIRD_TX_ID, 'ext-3', {
        kind: 'ROLLBACK',
        reference_external_transaction_id: 'ext-1',
        reference_transaction_id: TX_ID,
      }),
    ),
  ),
];

const ledgerCheck = (constraint: string, entry: Row): ConstraintCase =>
  check(constraint, insert('ledger_entries', entry), ledgerSetup);

const LEDGER_ENTRY_CASES: readonly ConstraintCase[] = [
  unique(
    'ledger_entries_pkey',
    [
      ...ledgerSetup,
      insert('wager_transactions', transaction(SECOND_TX_ID, 'ext-2')),
      insert('ledger_entries', houseEntry()),
    ],
    insert('ledger_entries', houseEntry({ transaction_id: SECOND_TX_ID })),
  ),
  ledgerCheck('ledger_entries_account_kind_ck', walletEntry({ account_kind: 'PLAYER' })),
  ledgerCheck('ledger_entries_direction_ck', houseEntry({ direction: 'SIDEWAYS' })),
  ledgerCheck('ledger_entries_shape_ck', walletEntry({ wallet_version: null })),
  ledgerCheck('ledger_entries_amount_positive_ck', houseEntry({ amount: '0.00' })),
  ledgerCheck(
    'ledger_entries_balances_non_negative_ck',
    walletEntry({ direction: 'DEBIT', balance_before: '5.00', balance_after: '-5.00' }),
  ),
  ledgerCheck('ledger_entries_arithmetic_ck', walletEntry({ balance_after: '5.00' })),
  ledgerCheck('ledger_entries_wallet_version_positive_ck', walletEntry({ wallet_version: 0 })),
  ledgerCheck('ledger_entries_currency_format_ck', houseEntry({ currency: 'brl' })),
  unique(
    'ledger_entries_one_per_wallet_uq',
    [...ledgerSetup, insert('ledger_entries', walletEntry())],
    insert(
      'ledger_entries',
      walletEntry({
        id: SECOND_ENTRY_ID,
        balance_before: '10.00',
        balance_after: '20.00',
        wallet_version: 2,
      }),
    ),
  ),
  unique(
    'ledger_entries_wallet_version_uq',
    [
      ...ledgerSetup,
      insert('wager_transactions', transaction(SECOND_TX_ID, 'ext-2')),
      insert('ledger_entries', walletEntry()),
    ],
    insert('ledger_entries', walletEntry({ id: SECOND_ENTRY_ID, transaction_id: SECOND_TX_ID })),
  ),
  unique(
    'ledger_entries_one_house_per_tx_uq',
    [...ledgerSetup, insert('ledger_entries', houseEntry())],
    insert('ledger_entries', houseEntry({ id: SECOND_ENTRY_ID })),
  ),
];

const SUPPORT_TABLE_CASES: readonly ConstraintCase[] = [
  unique(
    'idempotency_records_pkey',
    [insert('idempotency_records', idempotencyRecord())],
    insert('idempotency_records', idempotencyRecord({ payload_hash: 'b'.repeat(64) })),
  ),
  check(
    'idempotency_records_status_ck',
    insert('idempotency_records', idempotencyRecord({ http_status: 201 })),
  ),
  unique(
    'inbox_messages_pkey',
    [insert('inbox_messages', inboxMessage())],
    insert('inbox_messages', inboxMessage({ payload_hash: 'b'.repeat(64) })),
  ),
  unique(
    'outbox_messages_pkey',
    [insert('outbox_messages', outboxMessage())],
    insert('outbox_messages', outboxMessage({ event_type: 'WagerTransactionProcessed' })),
  ),
  check('outbox_messages_counters_ck', insert('outbox_messages', outboxMessage({ attempts: -1 }))),
  unique(
    'pending_reference_retries_pkey',
    [baseWallet, baseBet, insert('pending_reference_retries', pendingRetry())],
    insert('pending_reference_retries', pendingRetry({ deadline_at: NOW })),
  ),
  check(
    'pending_reference_retries_counters_ck',
    insert('pending_reference_retries', pendingRetry({ consecutive_errors: -1 })),
    [baseWallet, baseBet],
  ),
  unique('scheduled_jobs_pkey', [], insert('scheduled_jobs', { name: 'global-reconciliation' })),
  unique(
    'reconciliation_runs_pkey',
    [insert('reconciliation_runs', reconciliationRun())],
    insert('reconciliation_runs', reconciliationRun({ consistent: false })),
  ),
  check(
    'reconciliation_runs_scope_ck',
    insert('reconciliation_runs', reconciliationRun({ scope: 'HOUSE' })),
  ),
  check(
    'reconciliation_runs_wallet_ck',
    insert('reconciliation_runs', reconciliationRun({ scope: 'WALLET' })),
  ),
];

const CASES: readonly ConstraintCase[] = [
  ...WALLET_CASES,
  ...HOUSE_ACCOUNT_CASES,
  ...WAGER_TRANSACTION_CASES,
  ...LEDGER_ENTRY_CASES,
  ...SUPPORT_TABLE_CASES,
];

const SCHEMA_CONSTRAINTS_SQL = `SELECT c.conname AS name
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public' AND c.contype IN ('c', 'u', 'p') AND t.relname <> 'mikro_orm_migrations'
UNION
SELECT i.relname AS name
FROM pg_index x
JOIN pg_class i ON i.oid = x.indexrelid
JOIN pg_class t ON t.oid = x.indrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public' AND x.indisunique AND t.relname <> 'mikro_orm_migrations'`;

const withClient = async <T>(url: string, work: (client: Client) => Promise<T>): Promise<T> => {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
};

describe('schema constraints', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  beforeEach(() => {
    registerCurrentDatabase(database.superuserUrl);
  });

  it('covers every check, unique constraint and unique index of the schema', async () => {
    const names = await withClient(database.ownerUrl, async (client) => {
      const result = await client.query<{ name: string }>(SCHEMA_CONSTRAINTS_SQL);
      return result.rows.map((row) => row.name).sort();
    });
    expect(CASES.map((testCase) => testCase.constraint).sort()).toEqual(names);
  });

  for (const testCase of CASES) {
    it(`rejects a row that violates ${testCase.constraint}`, async () => {
      await withClient(database.ownerUrl, async (client) => {
        await client.query('BEGIN');
        try {
          for (const statement of testCase.setup) {
            await client.query(statement);
          }
          const failure = await client.query(testCase.violation).then(
            () => undefined,
            (reason: unknown) => reason,
          );
          expect(failure).toBeInstanceOf(DatabaseError);
          expect(failure).toMatchObject({ code: testCase.code, constraint: testCase.constraint });
        } finally {
          await client.query('ROLLBACK');
        }
      });
    });
  }
});
