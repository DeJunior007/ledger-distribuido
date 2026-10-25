import { z } from 'zod';
import { UUID_PATTERN } from './wager-transaction.schema';

export const LEDGER_DEFAULT_LIMIT = 50;
export const LEDGER_MAX_LIMIT = 200;

const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const LIMIT_PATTERN = /^[1-9]\d{0,2}$/;

export interface LedgerCursor {
  walletId: string;
  walletVersion: number;
}

export interface LedgerQuery {
  cursor: LedgerCursor | undefined;
  limit: number;
}

const cursorPayloadSchema = z
  .object({
    w: z.string().regex(UUID_PATTERN),
    v: z.number().int().positive().safe(),
  })
  .strict();

export const encodeLedgerCursor = (walletId: string, walletVersion: number): string =>
  Buffer.from(JSON.stringify({ w: walletId, v: walletVersion }), 'utf8').toString('base64url');

const parseJson = (text: string): unknown => {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
};

const decodeLedgerCursor = (cursor: string): LedgerCursor | undefined => {
  const decoded = cursorPayloadSchema.safeParse(
    parseJson(Buffer.from(cursor, 'base64url').toString('utf8')),
  );
  if (!decoded.success) {
    return undefined;
  }
  const walletId = decoded.data.w.toLowerCase();
  if (encodeLedgerCursor(walletId, decoded.data.v) !== cursor) {
    return undefined;
  }
  return { walletId, walletVersion: decoded.data.v };
};

const cursorSchema = z
  .string()
  .regex(CURSOR_PATTERN)
  .transform((cursor, context) => {
    const decoded = decodeLedgerCursor(cursor);
    if (decoded === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'cursor is invalid' });
      return z.NEVER;
    }
    return decoded;
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
    cursor: query.cursor,
    limit: query.limit ?? LEDGER_DEFAULT_LIMIT,
  }));
