const table = 'wallets';

export const correction = 'UPDATE ledger_entries SET amount = 0 WHERE id = $1';

export const removal = 'DELETE FROM wallets WHERE id = $1';

export const reset = 'TRUNCATE wallets';

export const tableLock = 'LOCK TABLE wallets IN EXCLUSIVE MODE';

export const sessionLock = 'SELECT pg_advisory_lock(42)';

export const transactionLock = 'SELECT pg_advisory_xact_lock(42)';

export const lockEverything = 'SELECT id FROM wallets FOR UPDATE';

export const chained = 'SELECT 1; delete from outbox_messages';

export const dynamicRemoval = `DELETE FROM ${table} WHERE id = $1`;
