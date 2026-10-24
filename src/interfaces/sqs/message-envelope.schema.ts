import { z } from 'zod';
import { wagerTransactionDataSchema } from '@interfaces/http/schemas/wager-transaction.schema';
import type { WagerTransactionData } from '@interfaces/http/schemas/wager-transaction.schema';

export const WAGER_TRANSACTION_REQUESTED = 'WagerTransactionRequested';

export const ENVELOPE_MESSAGE_ID_PATTERN = /^[\x21-\x7E]{1,128}$/;

export interface WagerTransactionEnvelope {
  readonly messageId: string;
  readonly type: typeof WAGER_TRANSACTION_REQUESTED;
  readonly occurredAt: string;
  readonly data: WagerTransactionData;
}

export const envelopeMessageIdSchema = z.string().regex(ENVELOPE_MESSAGE_ID_PATTERN);

export const wagerTransactionEnvelopeSchema = (
  supportedCurrencies: readonly string[],
): z.ZodType<WagerTransactionEnvelope, z.ZodTypeDef, unknown> =>
  z
    .object({
      messageId: envelopeMessageIdSchema,
      type: z.literal(WAGER_TRANSACTION_REQUESTED),
      occurredAt: z.string().datetime({ offset: true }),
      data: wagerTransactionDataSchema(supportedCurrencies),
    })
    .strict();

const readableEnvelopeSchema = z.object({ messageId: envelopeMessageIdSchema });

export const readEnvelopeMessageId = (body: string | undefined): string | undefined => {
  if (body === undefined) {
    return undefined;
  }
  try {
    const parsed = readableEnvelopeSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data.messageId : undefined;
  } catch {
    return undefined;
  }
};
