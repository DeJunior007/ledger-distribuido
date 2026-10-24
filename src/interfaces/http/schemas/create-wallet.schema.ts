import { z } from 'zod';
import type { MoneyProps } from '@domain/shared/money';
import { moneySchema, uuidSchema } from './wager-transaction.schema';

export interface CreateWalletBody {
  playerId: string;
  initialBalance: MoneyProps;
}

export const createWalletSchema = (
  supportedCurrencies: readonly string[],
): z.ZodType<CreateWalletBody, z.ZodTypeDef, unknown> =>
  z
    .object({
      playerId: uuidSchema,
      initialBalance: moneySchema(supportedCurrencies),
    })
    .strict();
