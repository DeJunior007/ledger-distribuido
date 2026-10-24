import { z } from 'zod';
import { corruptedRow } from '../mappers/persisted-values.mapper';

const timestamptz = z
  .string()
  .transform((value) => new Date(value))
  .pipe(z.date());

const outboxMessageRowSchema = z.object({
  id: z.string(),
  aggregate_id: z.string(),
  event_type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  occurred_at: timestamptz,
  attempts: z.number().int(),
  permanent_failures: z.number().int(),
  next_attempt_at: timestamptz,
  locked_until: timestamptz.nullable(),
  locked_by: z.string().nullable(),
  published_at: timestamptz.nullable(),
  parked_at: timestamptz.nullable(),
  last_error_code: z.string().nullable(),
});

const outboxGaugesRowSchema = z.object({
  pending: z.number().int(),
  parked: z.number().int(),
  stuck: z.number().int(),
  lag_seconds: z.number(),
});

const outboxStatementResultSchema = z.object({
  affectedRows: z.number().int(),
});

export type OutboxMessageRow = z.infer<typeof outboxMessageRowSchema>;

export type OutboxGaugesRow = z.infer<typeof outboxGaugesRowSchema>;

export function parseOutboxMessageRows(value: unknown): OutboxMessageRow[] {
  const result = z.array(outboxMessageRowSchema).safeParse(value);
  if (!result.success) {
    throw corruptedRow();
  }
  return result.data;
}

export function parseOutboxGaugesRow(value: unknown): OutboxGaugesRow {
  const result = z.tuple([outboxGaugesRowSchema]).safeParse(value);
  if (!result.success) {
    throw corruptedRow();
  }
  return result.data[0];
}

export function parseOutboxAffectedRows(value: unknown): number {
  const result = outboxStatementResultSchema.safeParse(value);
  if (!result.success) {
    throw corruptedRow();
  }
  return result.data.affectedRows;
}
