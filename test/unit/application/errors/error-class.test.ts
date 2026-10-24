import { describe, expect, it } from 'bun:test';
import { ApplicationError } from '@application/errors/application-error';
import { ErrorClass, TechnicalError, classifyError } from '@application/errors/error-class';
import { ForbiddenError } from '@application/errors/forbidden.error';
import { NotFoundError } from '@application/errors/not-found.error';
import { ProviderIdentityMismatchError } from '@application/errors/provider-identity-mismatch.error';
import { RollbackSignal } from '@application/errors/rollback-signal';
import { UnauthenticatedError } from '@application/errors/unauthenticated.error';
import { WalletAlreadyExistsError } from '@application/errors/wallet-already-exists.error';
import { DomainError } from '@domain/shared/domain-error';
import { FAILURE_CODE_METADATA, FailureCategory, FailureCode } from '@domain/shared/failure-code';

class CodedDomainError extends DomainError {
  constructor(readonly failureCode: FailureCode) {
    super('coded domain error');
    this.name = 'CodedDomainError';
  }
}

class UncodedDomainError extends DomainError {
  readonly failureCode = undefined;

  constructor() {
    super('uncoded domain error');
    this.name = 'UncodedDomainError';
  }
}

class CodedApplicationError extends ApplicationError {
  constructor(readonly failureCode: FailureCode) {
    super('coded application error');
    this.name = 'CodedApplicationError';
  }
}

const categoryCases: readonly (readonly [FailureCategory, FailureCode, ErrorClass])[] = [
  [FailureCategory.Validation, FailureCode.InvalidPayload, ErrorClass.Validation],
  [FailureCategory.Authentication, FailureCode.Unauthenticated, ErrorClass.Authentication],
  [FailureCategory.Authorization, FailureCode.Forbidden, ErrorClass.Authorization],
  [FailureCategory.NotFound, FailureCode.NotFound, ErrorClass.NotFound],
  [FailureCategory.Conflict, FailureCode.IdempotencyKeyConflict, ErrorClass.Conflict],
  [FailureCategory.Business, FailureCode.InsufficientFunds, ErrorClass.Business],
  [FailureCategory.Failed, FailureCode.ProcessingFailed, ErrorClass.Deterministic],
  [FailureCategory.Infrastructure, FailureCode.InfrastructureUnavailable, ErrorClass.Transient],
];

const technicalClasses = [
  ErrorClass.Race,
  ErrorClass.Transient,
  ErrorClass.Connectivity,
  ErrorClass.Permanent,
  ErrorClass.Deterministic,
] as const;

describe('classifyError', () => {
  it('covers every failure category in the category cases', () => {
    expect(categoryCases.map(([category]) => category).sort()).toEqual(
      Object.values(FailureCategory).sort(),
    );
    for (const [category, code] of categoryCases) {
      expect(FAILURE_CODE_METADATA[code].category).toBe(category);
    }
  });

  describe('rule 1: technical error', () => {
    for (const errorClass of technicalClasses) {
      it(`returns ${errorClass} for a technical error of class ${errorClass}`, () => {
        expect(classifyError(new TechnicalError(errorClass, 'deterministic'))).toBe(errorClass);
      });
    }
  });

  describe('rule 2: domain error with failure code', () => {
    for (const [category, code, expected] of categoryCases) {
      it(`maps category ${category} to ${expected}`, () => {
        expect(classifyError(new CodedDomainError(code))).toBe(expected);
      });
    }

    it('maps every failure code through its category', () => {
      for (const code of Object.values(FailureCode)) {
        const category = FAILURE_CODE_METADATA[code].category;
        const expected = categoryCases.find(([caseCategory]) => caseCategory === category)?.[2];
        expect(classifyError(new CodedDomainError(code))).toBe(expected ?? ErrorClass.Race);
      }
    });
  });

  describe('rule 3: domain error without failure code', () => {
    it('returns deterministic', () => {
      expect(classifyError(new UncodedDomainError())).toBe(ErrorClass.Deterministic);
    });
  });

  describe('rule 4: application error', () => {
    for (const [category, code, expected] of categoryCases) {
      it(`maps category ${category} to ${expected}`, () => {
        expect(classifyError(new CodedApplicationError(code))).toBe(expected);
      });
    }

    it('classifies the concrete application errors by their category', () => {
      expect(classifyError(new NotFoundError())).toBe(ErrorClass.NotFound);
      expect(classifyError(new WalletAlreadyExistsError('w-1'))).toBe(ErrorClass.Conflict);
      expect(classifyError(new UnauthenticatedError())).toBe(ErrorClass.Authentication);
      expect(classifyError(new ForbiddenError())).toBe(ErrorClass.Authorization);
      expect(classifyError(new ProviderIdentityMismatchError())).toBe(ErrorClass.Authorization);
    });
  });

  describe('rule 5: anything else', () => {
    it('returns deterministic for a plain error', () => {
      expect(classifyError(new TypeError('boom'))).toBe(ErrorClass.Deterministic);
    });

    it('returns deterministic for values that are not errors', () => {
      expect(classifyError('boom')).toBe(ErrorClass.Deterministic);
      expect(classifyError(undefined)).toBe(ErrorClass.Deterministic);
      expect(classifyError(null)).toBe(ErrorClass.Deterministic);
      expect(classifyError({ failureCode: FailureCode.InsufficientFunds })).toBe(
        ErrorClass.Deterministic,
      );
    });

    it('returns deterministic for a rollback signal', () => {
      expect(classifyError(new RollbackSignal({ ok: true }))).toBe(ErrorClass.Deterministic);
    });
  });
});

describe('TechnicalError', () => {
  it('passes the cause to the error constructor', () => {
    const cause = new Error('driver failure');
    const error = new TechnicalError(ErrorClass.Connectivity, 'connection', {
      cause,
      probe: 'database',
    });
    expect(error.cause).toBe(cause);
    expect(error.errorClass).toBe(ErrorClass.Connectivity);
    expect(error.reason).toBe('connection');
    expect(error.probe).toBe('database');
    expect(error.constraint).toBeUndefined();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('TechnicalError');
  });

  it('keeps the constraint name', () => {
    const error = new TechnicalError(ErrorClass.Race, 'race', {
      constraint: 'wager_transactions_provider_key_uq',
    });
    expect(error.constraint).toBe('wager_transactions_provider_key_uq');
    expect(error.probe).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });

  it('is neither a domain error nor an application error', () => {
    const error = new TechnicalError(ErrorClass.Transient, 'deadlock');
    expect(error).not.toBeInstanceOf(DomainError);
    expect(error).not.toBeInstanceOf(ApplicationError);
  });
});

describe('RollbackSignal', () => {
  it('carries a typed result', () => {
    const signal = new RollbackSignal<{ readonly status: number }>({ status: 409 });
    const status: number = signal.result.status;
    expect(status).toBe(409);
    expect(signal.message).toBe('rollback');
    expect(signal.name).toBe('RollbackSignal');
    expect(signal).toBeInstanceOf(Error);
  });

  it('is not a domain, application or technical error', () => {
    const signal = new RollbackSignal('result');
    expect(signal).not.toBeInstanceOf(DomainError);
    expect(signal).not.toBeInstanceOf(ApplicationError);
    expect(signal).not.toBeInstanceOf(TechnicalError);
  });
});
