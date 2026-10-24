import type { FailureCode } from './failure-code';

export abstract class DomainError extends Error {
  abstract readonly failureCode: FailureCode | undefined;
}
