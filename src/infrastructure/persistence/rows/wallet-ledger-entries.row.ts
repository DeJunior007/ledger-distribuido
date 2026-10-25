import { z } from 'zod';
import { LedgerDirection } from '@domain/wallet/ledger-direction';

const decimalText = z.string().regex(/^\d+\.\d{2}$/);

export const walletLedgerEntryRowSchema = z
  .object({
    id: z.string().uuid(),
    wallet_id: z.string().uuid(),
    transaction_id: z.string().uuid(),
    direction: z.nativeEnum(LedgerDirection),
    amount: decimalText,
    currency: z.string(),
    balance_before: decimalText,
    balance_after: decimalText,
    wallet_version: z.number().int().positive(),
    created_at: z.string().pipe(z.coerce.date()),
  })
  .transform((row) => ({
    id: row.id,
    walletId: row.wallet_id,
    transactionId: row.transaction_id,
    direction: row.direction,
    amount: row.amount,
    currency: row.currency,
    balanceBefore: row.balance_before,
    balanceAfter: row.balance_after,
    walletVersion: row.wallet_version,
    createdAt: row.created_at,
  }));

export const walletLedgerEntryRowsSchema = z.array(walletLedgerEntryRowSchema);

export type WalletLedgerEntryRow = z.infer<typeof walletLedgerEntryRowSchema>;
