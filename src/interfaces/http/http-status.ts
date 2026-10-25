import type { ProblemBody } from '@domain/idempotency/response-bodies';
import { FAILURE_CODE_METADATA, FailureCategory, FailureCode } from '@domain/shared/failure-code';
import type { FailureCodeMetadata } from '@domain/shared/failure-code';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export type FailureHttpStatus = FailureCodeMetadata['httpStatus'];

export interface ProblemExtras {
  readonly transactionId?: string | undefined;
  readonly walletId?: string | undefined;
  readonly errors?: readonly { readonly path: string; readonly message: string }[] | undefined;
}

const DETAIL_BY_CATEGORY: Readonly<Record<FailureCategory, string>> = {
  [FailureCategory.Validation]: 'The request is invalid',
  [FailureCategory.Authentication]: 'A valid bearer token is required',
  [FailureCategory.Authorization]: 'The caller is not allowed to perform this operation',
  [FailureCategory.NotFound]: 'The requested resource was not found',
  [FailureCategory.Conflict]: 'The request conflicts with the current state of the resource',
  [FailureCategory.Business]: 'The request was rejected by a business rule',
  [FailureCategory.Failed]: 'The request could not be completed',
  [FailureCategory.Infrastructure]: 'A dependency is temporarily unavailable; retry later',
};

const DETAIL_BY_CODE: Partial<Readonly<Record<FailureCode, string>>> = {
  [FailureCode.InternalError]: 'The request could not be processed; retry later',
};

export const httpStatusOf = (failureCode: FailureCode): FailureHttpStatus =>
  FAILURE_CODE_METADATA[failureCode].httpStatus;

export const problemTypeOf = (failureCode: FailureCode): string =>
  `urn:jungle:problem:${failureCode}`;

const titleOf = (failureCode: FailureCode): string => {
  const words = failureCode.toLowerCase().split('_').join(' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

const detailOf = (failureCode: FailureCode): string =>
  DETAIL_BY_CODE[failureCode] ?? DETAIL_BY_CATEGORY[FAILURE_CODE_METADATA[failureCode].category];

export const problemBodyOf = (
  failureCode: FailureCode,
  extras: ProblemExtras = {},
): ProblemBody => {
  const metadata = FAILURE_CODE_METADATA[failureCode];
  return {
    type: problemTypeOf(failureCode),
    title: titleOf(failureCode),
    status: metadata.httpStatus,
    detail: detailOf(failureCode),
    failureCode,
    retryable: metadata.retryable,
    action: metadata.action,
    ...(extras.transactionId === undefined ? {} : { transactionId: extras.transactionId }),
    ...(extras.walletId === undefined ? {} : { walletId: extras.walletId }),
    ...(extras.errors === undefined
      ? {}
      : { errors: extras.errors.map(({ path, message }) => ({ path, message })) }),
  };
};
