import { z } from 'zod';
import { DomainError } from '@domain/shared/domain-error';
import { FailureCode } from '@domain/shared/failure-code';

export interface ValidationProblem {
  readonly path: string;
  readonly message: string;
}

export class RequestValidationError extends DomainError {
  readonly failureCode: FailureCode;
  readonly errors: readonly ValidationProblem[];

  constructor(failureCode: FailureCode, errors: readonly ValidationProblem[]) {
    super(`request validation failed with ${failureCode}`);
    this.name = 'RequestValidationError';
    this.failureCode = failureCode;
    this.errors = errors;
  }
}

export type BodyLocation = 'root' | 'body' | 'none';

const FAILURE_CODE_PRIORITY: readonly FailureCode[] = [
  FailureCode.MissingIdempotencyKey,
  FailureCode.UnsupportedKind,
  FailureCode.InvalidMoney,
  FailureCode.UnsupportedCurrency,
  FailureCode.InvalidAmount,
  FailureCode.ReferenceRequired,
  FailureCode.InvalidPayload,
];

const MONEY_FIELDS: readonly (string | number)[] = ['money', 'initialBalance'];
const MONEY_PARTS: readonly (string | number)[] = ['amount', 'currency'];

const customFailureCode = (issue: z.ZodCustomIssue): FailureCode => {
  const declared: unknown = issue.params?.failureCode;
  return FAILURE_CODE_PRIORITY.find((code) => code === declared) ?? FailureCode.InvalidPayload;
};

const isMoneyFieldPath = (path: readonly (string | number)[]): boolean => {
  const [field, part] = path;
  return (
    path.length === 2 &&
    field !== undefined &&
    part !== undefined &&
    MONEY_FIELDS.includes(field) &&
    MONEY_PARTS.includes(part)
  );
};

export const failureCodeOfIssue = (issue: z.ZodIssue): FailureCode => {
  const [first, ...rest] = issue.path;
  if (first === 'idempotencyKey') {
    return FailureCode.MissingIdempotencyKey;
  }
  if (issue.code === z.ZodIssueCode.custom) {
    return customFailureCode(issue);
  }
  const fieldPath = first === 'body' ? rest : issue.path;
  if (fieldPath.length === 1 && fieldPath[0] === 'kind') {
    return FailureCode.UnsupportedKind;
  }
  if (issue.code !== z.ZodIssueCode.unrecognized_keys && isMoneyFieldPath(fieldPath)) {
    return FailureCode.InvalidMoney;
  }
  return FailureCode.InvalidPayload;
};

export const selectFailureCode = (issues: readonly z.ZodIssue[]): FailureCode => {
  const codes = issues.map(failureCodeOfIssue);
  return FAILURE_CODE_PRIORITY.find((code) => codes.includes(code)) ?? FailureCode.InvalidPayload;
};

const toProblem = (issue: z.ZodIssue): ValidationProblem => ({
  path: issue.path.join('.'),
  message: issue.message,
});

const bodyOf = (value: unknown, location: BodyLocation): unknown => {
  if (location === 'root') {
    return value;
  }
  return typeof value === 'object' && value !== null && 'body' in value ? value.body : undefined;
};

export class ZodValidationPipe<T> {
  constructor(
    private readonly schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    private readonly bodyLocation: BodyLocation = 'none',
  ) {}

  transform(value: unknown): T {
    if (this.bodyLocation !== 'none' && bodyOf(value, this.bodyLocation) === undefined) {
      throw new RequestValidationError(FailureCode.InvalidPayload, [
        { path: 'body', message: 'request body must be a JSON document' },
      ]);
    }
    const result = this.schema.safeParse(value);
    if (result.success) {
      return result.data;
    }
    throw new RequestValidationError(
      selectFailureCode(result.error.issues),
      result.error.issues.map(toProblem),
    );
  }
}
