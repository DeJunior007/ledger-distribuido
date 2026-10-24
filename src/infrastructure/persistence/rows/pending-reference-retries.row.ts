import { z } from 'zod';
import { corruptedRow } from '../mappers/persisted-values.mapper';

const timestamptz = z
  .string()
  .transform((value) => new Date(value))
  .pipe(z.date());

const pendingReferenceRetryRowSchema = z.object({
  transaction_id: z.string(),
  attempts: z.number().int(),
  consecutive_errors: z.number().int(),
  next_attempt_at: timestamptz,
  deadline_at: timestamptz,
  locked_until: timestamptz.nullable(),
  locked_by: z.string().nullable(),
  resolved_at: timestamptz.nullable(),
  created_at: timestamptz,
});

const pendingReferenceRenewedRowSchema = z.object({
  transaction_id: z.string(),
});

const pendingReferenceOpenCountRowSchema = z.object({
  open: z.number().int(),
});

const pendingReferenceStatementResultSchema = z.object({
  affectedRows: z.number().int(),
});

export type PendingReferenceRetryRow = z.infer<typeof pendingReferenceRetryRowSchema>;

export function parsePendingReferenceRetryRows(value: unknown): PendingReferenceRetryRow[] {
  const result = z.array(pendingReferenceRetryRowSchema).safeParse(value);
  if (!result.success) {
    throw corruptedRow();
  }
  return result.data;
}

export function parsePendingReferenceRenewedRows(value: unknown): number {
  const result = z.array(pendingReferenceRenewedRowSchema).safeParse(value);
  if (!result.success) {
    throw corruptedRow();
  }
  return result.data.length;
}

export function parsePendingReferenceOpenCount(value: unknown): number {
  const result = z.tuple([pendingReferenceOpenCountRowSchema]).safeParse(value);
  if (!result.success) {
    throw corruptedRow();
  }
  return result.data[0].open;
}

export function parsePendingReferenceAffectedRows(value: unknown): number {
  const result = pendingReferenceStatementResultSchema.safeParse(value);
  if (!result.success) {
    throw corruptedRow();
  }
  return result.data.affectedRows;
}
