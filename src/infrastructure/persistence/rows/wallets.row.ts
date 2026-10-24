import { z } from 'zod';

export const walletVersionRowSchema = z.object({
  version: z.number().int(),
});

export type WalletVersionRow = z.infer<typeof walletVersionRowSchema>;
