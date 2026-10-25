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
const FOREIGN_KEY_VIOLATION = '23503';

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

const THIRD_ENTRY_ID = '0196b000-0000-7000-8000-000000000042';
const MISSING_ID = '0196b000-0000-7000-8000-0000000000ff';

const foreignKey = (
  constraint: string,
  violation: QueryConfig,
  setup: readonly QueryConfig[] = [],
): ConstraintCase => ({ constraint, code: FOREIGN_KEY_VIOLATION, setup, violation });

const FOREIGN_KEY_CASES: readonly ConstraintCase[] = [
  foreignKey(
    'wager_transactions_wallet_fk',
    insert('wager_transactions', transaction(TX_ID, 'ext-1')),
  ),
  foreignKey(
    'wager_transactions_reference_fk',
    insert(
      'wager_transactions',
      transaction(TX_ID, 'ext-1', { reference_transaction_id: MISSING_ID }),
    ),
    [baseWallet],
  ),
  foreignKey(
    'ledger_entries_transaction_fk',
    insert('ledger_entries', houseEntry({ transaction_id: MISSING_ID })),
    [baseHouse],
  ),
  foreignKey(
    'ledger_entries_wallet_fk',
    insert('ledger_entries', walletEntry({ wallet_id: MISSING_ID })),
    [baseWallet, baseBet],
  ),
  foreignKey(
    'ledger_entries_house_account_fk',
    insert('ledger_entries', houseEntry({ house_account_id: MISSING_ID })),
    [baseWallet, baseBet],
  ),
  foreignKey(
    'idempotency_records_transaction_fk',
    insert('idempotency_records', idempotencyRecord({ transaction_id: MISSING_ID })),
  ),
  foreignKey(
    'pending_reference_retries_transaction_fk',
    insert('pending_reference_retries', pendingRetry({ transaction_id: MISSING_ID })),
  ),
];

const CASES: readonly ConstraintCase[] = [
  ...WALLET_CASES,
  ...HOUSE_ACCOUNT_CASES,
  ...WAGER_TRANSACTION_CASES,
  ...LEDGER_ENTRY_CASES,
  ...SUPPORT_TABLE_CASES,
  ...FOREIGN_KEY_CASES,
];

const PLAIN_INDEXES: readonly (readonly [string, string])[] = [
  ['wager_transactions_pending_ref_idx', "WHERE (status = 'PENDING_REFERENCE'::text)"],
  ['wager_transactions_round_idx', '(wallet_id, round_id)'],
  ['ledger_entries_house_account_idx', "WHERE (account_kind = 'HOUSE'::text)"],
  ['outbox_messages_due_idx', 'WHERE (published_at IS NULL)'],
  ['pending_reference_retries_due_idx', 'WHERE (resolved_at IS NULL)'],
];

const PARTIAL_UNIQUE_INDEXES: readonly string[] = [
  'wager_transactions_single_opening_uq',
  'wager_transactions_single_reversal_uq',
  'ledger_entries_one_per_wallet_uq',
  'ledger_entries_wallet_version_uq',
  'ledger_entries_one_house_per_tx_uq',
];

interface TriggerCase {
  readonly trigger: string;
  readonly table: string;
  readonly code: string;
  readonly deferred: boolean;
  readonly statements: readonly (string | QueryConfig)[];
}

const LOSS_TX = insert(
  'wager_transactions',
  transaction(SECOND_TX_ID, 'ext-loss', { kind: 'LOSS', amount: '0.00' }),
);
const BET_TX = insert('wager_transactions', transaction(SECOND_TX_ID, 'ext-bet'));

const TRIGGER_CASES: readonly TriggerCase[] = [
  {
    trigger: 'ledger_entries_immutable_row',
    table: 'ledger_entries',
    code: 'JG001',
    deferred: false,
    statements: ["UPDATE ledger_entries SET created_at = created_at + interval '1 second'"],
  },
  {
    trigger: 'ledger_entries_immutable_truncate',
    table: 'ledger_entries',
    code: 'JG001',
    deferred: false,
    statements: ['TRUNCATE ledger_entries'],
  },
  {
    trigger: 'wallets_ledger_chain',
    table: 'wallets',
    code: 'JG002',
    deferred: true,
    statements: ["UPDATE wallets SET balance = '50.00', version = 2"],
  },
  {
    trigger: 'ledger_entries_consistency',
    table: 'ledger_entries',
    code: 'JG003',
    deferred: true,
    statements: [
      LOSS_TX,
      insert(
        'ledger_entries',
        houseEntry({ id: THIRD_ENTRY_ID, transaction_id: SECOND_TX_ID, amount: '1.00' }),
      ),
    ],
  },
  {
    trigger: 'ledger_entries_transaction_balance',
    table: 'ledger_entries',
    code: 'JG004',
    deferred: true,
    statements: [
      BET_TX,
      insert(
        'ledger_entries',
        walletEntry({
          id: THIRD_ENTRY_ID,
          transaction_id: SECOND_TX_ID,
          direction: 'DEBIT',
          balance_before: '100.00',
          balance_after: '90.00',
          wallet_version: 2,
        }),
      ),
      "UPDATE wallets SET balance = '90.00', version = 2",
    ],
  },
  {
    trigger: 'wager_transactions_guard_row',
    table: 'wager_transactions',
    code: 'JG005',
    deferred: false,
    statements: ["UPDATE wager_transactions SET updated_at = updated_at + interval '1 second'"],
  },
  {
    trigger: 'wager_transactions_guard_truncate',
    table: 'wager_transactions',
    code: 'JG005',
    deferred: false,
    statements: ['TRUNCATE wager_transactions CASCADE'],
  },
  {
    trigger: 'wallets_no_delete_row',
    table: 'wallets',
    code: 'JG006',
    deferred: false,
    statements: ['DELETE FROM wallets'],
  },
  {
    trigger: 'wallets_no_delete_truncate',
    table: 'wallets',
    code: 'JG006',
    deferred: false,
    statements: ['TRUNCATE wallets CASCADE'],
  },
  {
    trigger: 'idempotency_records_guard_row',
    table: 'idempotency_records',
    code: 'JG007',
    deferred: false,
    statements: ["UPDATE idempotency_records SET updated_at = updated_at + interval '1 second'"],
  },
  {
    trigger: 'idempotency_records_guard_truncate',
    table: 'idempotency_records',
    code: 'JG007',
    deferred: false,
    statements: ['TRUNCATE idempotency_records'],
  },
];

const OPENING_TX = insert(
  'wager_transactions',
  transaction(TX_ID, 'opening-1', {
    provider_id: SYSTEM_PROVIDER,
    kind: 'OPENING',
    amount: '100.00',
  }),
);

const LEDGER_SEED: readonly QueryConfig[] = [
  insert('house_accounts', houseAccount()),
  insert('house_accounts', houseAccount({ id: OTHER_HOUSE_ID, purpose: 'FUNDING' })),
  insert('wallets', wallet({ balance: '100.00' })),
  OPENING_TX,
  insert('ledger_entries', walletEntry({ amount: '100.00', balance_after: '100.00' })),
  insert(
    'ledger_entries',
    houseEntry({ id: SECOND_ENTRY_ID, house_account_id: OTHER_HOUSE_ID, amount: '100.00' }),
  ),
  insert('idempotency_records', idempotencyRecord({ transaction_id: TX_ID })),
];

const SCHEMA_CONSTRAINTS_SQL = `SELECT c.conname AS name
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public' AND c.contype IN ('c', 'u', 'p', 'f') AND t.relname <> 'mikro_orm_migrations'
UNION
SELECT i.relname AS name
FROM pg_index x
JOIN pg_class i ON i.oid = x.indexrelid
JOIN pg_class t ON t.oid = x.indrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public' AND x.indisunique AND t.relname <> 'mikro_orm_migrations'`;

const SCHEMA_TRIGGERS_SQL = `SELECT t.tgname AS name, t.tgdeferrable AS deferrable, t.tginitdeferred AS deferred
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT t.tgisinternal`;

const withClient = async <T>(url: string, work: (client: Client) => Promise<T>): Promise<T> => {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
};

const queryNames = (url: string, sql: string): Promise<Record<string, unknown>[]> =>
  withClient(url, async (client) => (await client.query<Record<string, unknown>>(sql)).rows);

const provoke = (url: string, statements: readonly (string | QueryConfig)[]): Promise<unknown> =>
  withClient(url, async (client) => {
    await client.query('BEGIN');
    try {
      for (const statement of statements) {
        await client.query(statement);
      }
      await client.query('COMMIT');
      return undefined;
    } catch (reason: unknown) {
      await client.query('ROLLBACK');
      return reason;
    }
  });

describe('r5-9 constraints named in spec 05 exist and fire', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  beforeEach(() => {
    registerCurrentDatabase(database.superuserUrl);
  });

  it('has exactly the constraints and unique indexes of the schema in pg_constraint and pg_index', async () => {
    const rows = await queryNames(database.ownerUrl, SCHEMA_CONSTRAINTS_SQL);
    expect(rows.map((row) => row.name).sort()).toEqual(
      [...CASES.map((testCase) => testCase.constraint)].sort(),
    );
  });

  for (const testCase of CASES) {
    it(`fires ${testCase.constraint} when SQL violates it`, async () => {
      const failure = await provoke(database.ownerUrl, [...testCase.setup, testCase.violation]);
      expect(failure).toBeInstanceOf(DatabaseError);
      expect(failure).toMatchObject({ code: testCase.code, constraint: testCase.constraint });
    });
  }
});

describe('r5-9 indexes named in spec 05 exist', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  beforeEach(() => {
    registerCurrentDatabase(database.superuserUrl);
  });

  it('lists every partial unique index in pg_indexes', async () => {
    const rows = await queryNames(
      database.ownerUrl,
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexdef LIKE 'CREATE UNIQUE INDEX%'`,
    );
    const names = rows.map((row) => row.indexname);
    for (const name of PARTIAL_UNIQUE_INDEXES) {
      expect(names).toContain(name);
    }
  });

  for (const [name, definition] of PLAIN_INDEXES) {
    it(`lists ${name} in pg_indexes with its definition`, async () => {
      const rows = await queryNames(
        database.ownerUrl,
        `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = '${name}'`,
      );
      expect(rows).toHaveLength(1);
      expect(String(rows[0]?.indexdef)).toContain(definition);
    });
  }
});

describe('r5-9 triggers named in spec 05 exist and fire', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
    const failure = await provoke(database.ownerUrl, LEDGER_SEED);
    expect(failure).toBeUndefined();
  });

  beforeEach(() => {
    registerCurrentDatabase(database.superuserUrl);
  });

  it('has exactly the triggers of the schema in pg_trigger', async () => {
    const rows = await queryNames(database.ownerUrl, SCHEMA_TRIGGERS_SQL);
    expect(rows.map((row) => row.name).sort()).toEqual(
      TRIGGER_CASES.map((testCase) => testCase.trigger).sort(),
    );
  });

  for (const testCase of TRIGGER_CASES) {
    it(`fires ${testCase.trigger} with ${testCase.code} on ${testCase.table}`, async () => {
      const rows = await queryNames(database.ownerUrl, SCHEMA_TRIGGERS_SQL);
      const registered = rows.find((row) => row.name === testCase.trigger);
      expect(registered?.deferred).toBe(testCase.deferred);
      expect(registered?.deferrable).toBe(testCase.deferred);
      const failure = await provoke(database.ownerUrl, testCase.statements);
      expect(failure).toBeInstanceOf(DatabaseError);
      expect(failure).toMatchObject({ code: testCase.code });
    });
  }
});
