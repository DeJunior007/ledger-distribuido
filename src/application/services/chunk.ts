import { ErrorClass, TechnicalError } from '@application/errors/error-class';

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new TechnicalError(ErrorClass.Deterministic, 'deterministic', {
      cause: new RangeError(`chunk size must be a positive integer, got ${String(size)}`),
    });
  }
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}
