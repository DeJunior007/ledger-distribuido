const table = 'wallets';

export const lockWallet = 'SELECT id, balance FROM wallets WHERE id = $1 FOR UPDATE NOWAIT';

export const claimRetries = `UPDATE pending_reference_retries SET locked_until = now() WHERE transaction_id IN (SELECT transaction_id FROM pending_reference_retries WHERE resolved_at IS NULL FOR UPDATE SKIP LOCKED)`;

export const debitWallet = `UPDATE ${table} SET balance = balance - $1 WHERE id = $2`;

export const appendEntry = 'INSERT INTO ledger_entries (id, wallet_id, amount) VALUES ($1, $2, $3)';

export const cartMessage = 'deleted from cart';

export const longerCartMessage = 'the item was deleted from cart';

export const advice = 'please do not delete from the cart; it is shared';

export const truncatedLabel = 'Truncated description';
