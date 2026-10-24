import { z } from 'zod';
import { LedgerDirection } from '@domain/wallet/ledger-direction';

const decimalText = z.string().regex(/^-?\d+\.\d{2}$/);

const count = z.number().int().nonnegative();

const optionalVersion = z
  .number()
  .int()
  .nullable()
  .transform((value) => value ?? undefined);

export const snapshotWalletRowSchema = z
  .object({
    id: z.string().uuid(),
    currency: z.string(),
    balance: decimalText,
    version: z.number().int(),
  })
  .transform((row) => ({
    walletId: row.id,
    currency: row.currency,
    balance: row.balance,
    version: row.version,
  }));

export const snapshotTotalsRowSchema = z.object({
  credits: decimalText,
  debits: decimalText,
  entries: count,
});

export const snapshotChainRowSchema = z
  .object({
    wallet_version: z.number().int(),
    direction: z.nativeEnum(LedgerDirection),
    amount: decimalText,
    currency: z.string(),
    balance_before: decimalText,
    balance_after: decimalText,
  })
  .transform((row) => ({
    walletVersion: row.wallet_version,
    direction: row.direction,
    amount: row.amount,
    currency: row.currency,
    balanceBefore: row.balance_before,
    balanceAfter: row.balance_after,
  }));

export const currencySumsRowSchema = z
  .object({
    currency: z.string(),
    wallets_total: decimalText,
    funding_balance: decimalText,
    gaming_balance: decimalText,
    ledger_net: decimalText,
  })
  .transform((row) => ({
    currency: row.currency,
    walletsTotal: row.wallets_total,
    fundingBalance: row.funding_balance,
    gamingBalance: row.gaming_balance,
    ledgerNet: row.ledger_net,
  }));

export const walletBatchRowSchema = z
  .object({
    id: z.string().uuid(),
    balance: decimalText,
    version: z.number().int(),
    calculated: decimalText,
    entries: count,
    first_version: optionalVersion,
    last_version: optionalVersion,
  })
  .transform((row) => ({
    walletId: row.id,
    balance: row.balance,
    version: row.version,
    calculated: row.calculated,
    entries: row.entries,
    firstVersion: row.first_version,
    lastVersion: row.last_version,
  }));
