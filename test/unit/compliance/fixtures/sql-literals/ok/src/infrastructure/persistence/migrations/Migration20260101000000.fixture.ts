export const cleanup = 'DELETE FROM wallets';

export const reset = 'TRUNCATE wallets';

export const lock = 'LOCK TABLE wallets IN EXCLUSIVE MODE';

export const correction = 'UPDATE ledger_entries SET amount = 0';
