import { DomainError } from '@domain/shared/domain-error';
import { FAILURE_CODE_METADATA, FailureCategory } from '@domain/shared/failure-code';
import type { FailureCode } from '@domain/shared/failure-code';
import { ApplicationError } from './application-error';

export enum ErrorClass {
  Validation = 'VALIDATION',
  Authentication = 'AUTHENTICATION',
  Authorization = 'AUTHORIZATION',
  NotFound = 'NOT_FOUND',
  Conflict = 'CONFLICT',
  Business = 'BUSINESS',
  Race = 'RACE',
  Transient = 'TRANSIENT',
  Connectivity = 'CONNECTIVITY',
  Permanent = 'PERMANENT',
  Deterministic = 'DETERMINISTIC',
}

export type TechnicalReason =
  | 'race'
  | 'race_repeated'
  | 'inbox'
  | 'lock_timeout'
  | 'statement_timeout'
  | 'transaction_timeout'
  | 'serialization'
  | 'deadlock'
  | 'version_mismatch'
  | 'pool_exhausted'
  | 'connection'
  | 'processing_timeout'
  | 'queue_transient'
  | 'queue_permanent'
  | 'wallet_version_drift'
  | 'inbox_without_record'
  | 'deterministic';

export class TechnicalError extends Error {
  readonly constraint: string | undefined;
  readonly probe: 'database' | 'queue' | undefined;

  constructor(
    readonly errorClass:
      | ErrorClass.Race
      | ErrorClass.Transient
      | ErrorClass.Connectivity
      | ErrorClass.Permanent
      | ErrorClass.Deterministic,
    readonly reason: TechnicalReason,
    options?: { cause?: unknown; constraint?: string; probe?: 'database' | 'queue' },
  ) {
    super(`${errorClass}: ${reason}`, { cause: options?.cause });
    this.name = 'TechnicalError';
    this.constraint = options?.constraint;
    this.probe = options?.probe;
  }
}

const ERROR_CLASS_BY_CATEGORY: Readonly<Record<FailureCategory, ErrorClass>> = {
  [FailureCategory.Validation]: ErrorClass.Validation,
  [FailureCategory.Authentication]: ErrorClass.Authentication,
  [FailureCategory.Authorization]: ErrorClass.Authorization,
  [FailureCategory.NotFound]: ErrorClass.NotFound,
  [FailureCategory.Conflict]: ErrorClass.Conflict,
  [FailureCategory.Business]: ErrorClass.Business,
  [FailureCategory.Failed]: ErrorClass.Deterministic,
  [FailureCategory.Infrastructure]: ErrorClass.Transient,
};

const errorClassOfCode = (failureCode: FailureCode): ErrorClass =>
  ERROR_CLASS_BY_CATEGORY[FAILURE_CODE_METADATA[failureCode].category];

export function classifyError(error: unknown): ErrorClass {
  if (error instanceof TechnicalError) {
    return error.errorClass;
  }
  if (error instanceof DomainError) {
    return error.failureCode === undefined
      ? ErrorClass.Deterministic
      : errorClassOfCode(error.failureCode);
  }
  if (error instanceof ApplicationError) {
    return errorClassOfCode(error.failureCode);
  }
  return ErrorClass.Deterministic;
}
