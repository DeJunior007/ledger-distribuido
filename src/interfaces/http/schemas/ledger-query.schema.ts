import { z } from 'zod';

export const LEDGER_DEFAULT_LIMIT = 50;
export const LEDGER_MAX_LIMIT = 200;

const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const LIMIT_PATTERN = /^[1-9]\d{0,2}$/;

export interface LedgerQuery {
  beforeWalletVersion: number | undefined;
  limit: number;
}

const cursorPayloadSchema = z.object({ v: z.number().int().positive().safe() }).strict();

export const encodeLedgerCursor = (walletVersion: number): string =>
  Buffer.from(JSON.stringify({ v: walletVersion }), 'utf8').toString('base64url');

const parseJson = (text: string): unknown => {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
};

const decodeLedgerCursor = (cursor: string): number | undefined => {
  const decoded = cursorPayloadSchema.safeParse(
    parseJson(Buffer.from(cursor, 'base64url').toString('utf8')),
  );
  if (!decoded.success || encodeLedgerCursor(decoded.data.v) !== cursor) {
    return undefined;
  }
  return decoded.data.v;
};

const cursorSchema = z
  .string()
  .regex(CURSOR_PATTERN)
  .transform((cursor, context) => {
    const walletVersion = decodeLedgerCursor(cursor);
    if (walletVersion === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'cursor is invalid' });
      return z.NEVER;
    }
    return walletVersion;
  });

const limitSchema = z
  .string()
  .regex(LIMIT_PATTERN)
  .transform(Number)
  .pipe(z.number().int().min(1).max(LEDGER_MAX_LIMIT));

export const ledgerQuerySchema: z.ZodType<LedgerQuery, z.ZodTypeDef, unknown> = z
  .object({
    cursor: cursorSchema.optional(),
    limit: limitSchema.optional(),
  })
  .strict()
  .transform((query) => ({
    beforeWalletVersion: query.cursor,
    limit: query.limit ?? LEDGER_DEFAULT_LIMIT,
  }));
