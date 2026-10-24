import { DriverException, OptimisticLockError } from '@mikro-orm/core';
import { ApplicationError } from '@application/errors/application-error';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import type { TechnicalReason } from '@application/errors/error-class';
import { RollbackSignal } from '@application/errors/rollback-signal';
import { DomainError } from '@domain/shared/domain-error';

const MAX_CAUSE_DEPTH = 8;

const UNIQUE_VIOLATION = '23505';

const RACE_CONSTRAINTS: readonly string[] = [
  'wallets_player_currency_uq',
  'wager_transactions_provider_key_uq',
  'wager_transactions_provider_external_uq',
  'idempotency_records_pkey',
  'inbox_messages_pkey',
  'wager_transactions_single_reversal_uq',
];

const TRANSIENT_REASON_BY_CODE: Readonly<Partial<Record<string, TechnicalReason>>> = {
  '55P03': 'lock_timeout',
  '57014': 'statement_timeout',
  '25P04': 'transaction_timeout',
  '40001': 'serialization',
  '40P01': 'deadlock',
};

const CONNECTION_CODES: readonly string[] = [
  '57P01',
  '57P02',
  '57P03',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
];

const CONNECTION_EXCEPTION_CLASS = '08';

const CONNECTION_MESSAGES: readonly string[] = ['Connection terminated', 'Query read timeout'];

const POOL_EXHAUSTED_MESSAGE = 'Knex: Timeout acquiring a connection';

interface DriverFailure {
  readonly code: string;
  readonly constraint: string | undefined;
}

const isPassThrough = (error: unknown): boolean =>
  error instanceof RollbackSignal ||
  error instanceof DomainError ||
  error instanceof ApplicationError ||
  error instanceof TechnicalError;

const stringProperty = (value: object, key: string): string | undefined => {
  const property: unknown = Reflect.get(value, key);
  return typeof property === 'string' && property !== '' ? property : undefined;
};

const causeChain = (error: unknown): readonly object[] => {
  const chain: object[] = [];
  let current: unknown = error;
  while (typeof current === 'object' && current !== null && chain.length < MAX_CAUSE_DEPTH) {
    if (chain.includes(current)) {
      break;
    }
    chain.push(current);
    current = Reflect.get(current, 'cause');
  }
  return chain;
};

const driverFailureOf = (chain: readonly object[]): DriverFailure | undefined => {
  for (const link of chain) {
    const code = stringProperty(link, 'code') ?? stringProperty(link, 'sqlState');
    if (code !== undefined) {
      return { code, constraint: stringProperty(link, 'constraint') };
    }
  }
  return undefined;
};

const messageOf = (link: object): string => stringProperty(link, 'message') ?? '';

const hasConnectionMessage = (chain: readonly object[]): boolean =>
  chain.some((link) => CONNECTION_MESSAGES.some((text) => messageOf(link).includes(text)));

const isPoolExhausted = (chain: readonly object[]): boolean =>
  chain.some(
    (link) =>
      link instanceof DriverException &&
      stringProperty(link, 'code') === undefined &&
      messageOf(link).startsWith(POOL_EXHAUSTED_MESSAGE),
  );

const isConnectionCode = (code: string): boolean =>
  code.startsWith(CONNECTION_EXCEPTION_CLASS) || CONNECTION_CODES.includes(code);

const connectionError = (reason: TechnicalReason, cause: unknown): TechnicalError =>
  new TechnicalError(ErrorClass.Connectivity, reason, { cause, probe: 'database' });

const withConstraint = (
  cause: unknown,
  constraint: string | undefined,
): { cause: unknown; constraint?: string } =>
  constraint === undefined ? { cause } : { cause, constraint };

const fromDriverFailure = (failure: DriverFailure, cause: unknown): TechnicalError | undefined => {
  const options = withConstraint(cause, failure.constraint);
  if (
    failure.code === UNIQUE_VIOLATION &&
    failure.constraint !== undefined &&
    RACE_CONSTRAINTS.includes(failure.constraint)
  ) {
    return new TechnicalError(ErrorClass.Race, 'race', options);
  }
  const transientReason = TRANSIENT_REASON_BY_CODE[failure.code];
  if (transientReason !== undefined) {
    return new TechnicalError(ErrorClass.Transient, transientReason, options);
  }
  if (isConnectionCode(failure.code)) {
    return connectionError('connection', cause);
  }
  return undefined;
};

const classify = (error: unknown): TechnicalError => {
  if (error instanceof OptimisticLockError) {
    return new TechnicalError(ErrorClass.Transient, 'version_mismatch', { cause: error });
  }
  const chain = causeChain(error);
  const failure = driverFailureOf(chain);
  const fromCode = failure === undefined ? undefined : fromDriverFailure(failure, error);
  if (fromCode !== undefined) {
    return fromCode;
  }
  if (hasConnectionMessage(chain)) {
    return connectionError('connection', error);
  }
  if (failure === undefined && isPoolExhausted(chain)) {
    return connectionError('pool_exhausted', error);
  }
  return new TechnicalError(
    ErrorClass.Deterministic,
    'deterministic',
    withConstraint(error, failure?.constraint),
  );
};

export const pgErrorClassifier = {
  wrap(error: unknown): unknown {
    return isPassThrough(error) ? error : classify(error);
  },
};
