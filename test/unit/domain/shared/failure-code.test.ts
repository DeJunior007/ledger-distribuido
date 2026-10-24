import { describe, expect, it } from 'bun:test';
import {
  FAILURE_CODE_METADATA,
  FailureAction,
  FailureCategory,
  FailureCode,
  PERSISTED_REJECTION_CODES,
} from '@domain/shared/failure-code';

const CHECK_CONSTRAINT_CODES = [
  'PLAYER_WALLET_MISMATCH',
  'CURRENCY_MISMATCH',
  'INSUFFICIENT_FUNDS',
  'INSUFFICIENT_FUNDS_FOR_REVERSAL',
  'BALANCE_LIMIT_EXCEEDED',
  'REFERENCE_NOT_FOUND',
  'REFERENCE_MISMATCH',
  'INVALID_REFERENCE_KIND',
  'REFERENCE_NOT_PROCESSED',
  'REFERENCE_ALREADY_REVERSED',
  'AMOUNT_MISMATCH',
  'PROCESSING_FAILED',
];

const STATUS_BY_CATEGORY: Record<FailureCategory, number> = {
  [FailureCategory.Validation]: 400,
  [FailureCategory.Authentication]: 401,
  [FailureCategory.Authorization]: 403,
  [FailureCategory.NotFound]: 404,
  [FailureCategory.Conflict]: 409,
  [FailureCategory.Business]: 422,
  [FailureCategory.Failed]: 500,
  [FailureCategory.Infrastructure]: 503,
};

describe('failure codes', () => {
  const codes = Object.values(FailureCode);

  it('defines exactly 29 codes', () => {
    expect(codes).toHaveLength(29);
  });

  it('has metadata for every code', () => {
    expect(Object.keys(FAILURE_CODE_METADATA).sort()).toEqual([...codes].sort());
  });

  it('maps each category to its http status', () => {
    for (const code of codes) {
      const metadata = FAILURE_CODE_METADATA[code];
      const expected = STATUS_BY_CATEGORY[metadata.category];
      const actual: number = metadata.httpStatus;
      expect(actual).toBe(expected);
    }
  });

  it('marks only authentication and infrastructure codes as retryable', () => {
    const retryable = codes.filter((code) => FAILURE_CODE_METADATA[code].retryable).sort();
    expect(retryable).toEqual(
      [
        FailureCode.Unauthenticated,
        FailureCode.InternalError,
        FailureCode.InfrastructureUnavailable,
      ].sort(),
    );
  });

  it('assigns the documented actions', () => {
    expect(FAILURE_CODE_METADATA[FailureCode.Unauthenticated].action).toBe(
      FailureAction.Reauthenticate,
    );
    expect(FAILURE_CODE_METADATA[FailureCode.Forbidden].action).toBe(FailureAction.GiveUp);
    expect(FAILURE_CODE_METADATA[FailureCode.ProviderIdentityMismatch].action).toBe(
      FailureAction.FixPayload,
    );
    expect(FAILURE_CODE_METADATA[FailureCode.WalletAlreadyExists].action).toBe(
      FailureAction.GiveUp,
    );
    expect(FAILURE_CODE_METADATA[FailureCode.IdempotencyKeyConflict].action).toBe(
      FailureAction.FixPayload,
    );
    expect(FAILURE_CODE_METADATA[FailureCode.InternalError].action).toBe(FailureAction.Retry);
    expect(FAILURE_CODE_METADATA[FailureCode.InfrastructureUnavailable].action).toBe(
      FailureAction.Retry,
    );
    expect(FAILURE_CODE_METADATA[FailureCode.InvalidPayload].action).toBe(FailureAction.FixPayload);
  });

  it('persists the eleven business rejections without wallet not found', () => {
    expect(PERSISTED_REJECTION_CODES).toHaveLength(11);
    expect(PERSISTED_REJECTION_CODES).not.toContain(FailureCode.WalletNotFound);
    for (const code of PERSISTED_REJECTION_CODES) {
      expect(FAILURE_CODE_METADATA[code].category).toBe(FailureCategory.Business);
    }
  });

  it('matches the database check list plus processing failed', () => {
    const persisted: string[] = [...PERSISTED_REJECTION_CODES, FailureCode.ProcessingFailed];
    expect(persisted).toEqual(CHECK_CONSTRAINT_CODES);
  });
});
