import { z } from 'zod';
import { corruptedRow } from '../mappers/persisted-values.mapper';

const scheduledJobAcquiredRowSchema = z.object({
  name: z.string(),
});

export function parseScheduledJobAcquiredRows(value: unknown): number {
  const result = z.array(scheduledJobAcquiredRowSchema).safeParse(value);
  if (!result.success) {
    throw corruptedRow();
  }
  return result.data.length;
}
