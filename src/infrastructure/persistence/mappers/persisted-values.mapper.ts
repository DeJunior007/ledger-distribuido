import { ErrorClass, TechnicalError } from '@application/errors/error-class';

export function parseEnum<T extends string>(values: Readonly<Record<string, T>>, raw: string): T {
  for (const value of Object.values(values)) {
    if (value === raw) {
      return value;
    }
  }
  throw new TechnicalError(ErrorClass.Deterministic, 'deterministic');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function corruptedRow(): TechnicalError {
  return new TechnicalError(ErrorClass.Deterministic, 'deterministic');
}
