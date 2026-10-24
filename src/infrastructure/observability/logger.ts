import { pino } from 'pino';
import type { DestinationStream, Logger, LoggerOptions } from 'pino';
import { TechnicalError } from '@application/errors/error-class';
import type { AppConfig } from '@infrastructure/config/env.schema';
import { requestContext } from './request-context';

export const REDACTED_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'req.body',
  'res.body',
  '*.money',
  '*.balance',
  '*.initialBalance',
  '*.amount',
  '*.balanceBefore',
  '*.balanceAfter',
  '*.storedBalance',
  '*.calculatedBalance',
  '*.difference',
];

export interface LoggerSettings {
  readonly level: AppConfig['LOG_LEVEL'];
  readonly service: string;
  readonly instanceId: string;
}

export type SerializedError = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

const stringField = (
  source: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
};

const isDriverError = (value: unknown): value is Readonly<Record<string, unknown>> =>
  isRecord(value) &&
  (stringField(value, 'sqlState') !== undefined || stringField(value, 'code') !== undefined);

const nameOf = (value: Readonly<Record<string, unknown>>): string =>
  stringField(value, 'name') ?? (value instanceof Error ? value.constructor.name : 'Error');

const compact = (fields: Readonly<Record<string, string | undefined>>): SerializedError =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

const driverCode = (value: Readonly<Record<string, unknown>>): string | undefined =>
  stringField(value, 'code') ?? stringField(value, 'sqlState');

const serializeDriverError = (error: Readonly<Record<string, unknown>>): SerializedError =>
  compact({
    name: nameOf(error),
    code: driverCode(error),
    constraint: stringField(error, 'constraint'),
  });

const serializeTechnicalError = (error: TechnicalError): SerializedError => {
  const cause: unknown = error.cause;
  const causeFields = isRecord(cause) ? cause : {};
  return compact({
    name: error.name,
    code: driverCode(causeFields),
    constraint: error.constraint ?? stringField(causeFields, 'constraint'),
    reason: error.reason,
  });
};

export const serializeError = (error: unknown): unknown => {
  if (error instanceof TechnicalError) {
    return serializeTechnicalError(error);
  }
  if (isDriverError(error)) {
    return serializeDriverError(error);
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(error.cause === undefined ? {} : { cause: serializeError(error.cause) }),
    };
  }
  return error;
};

const safeMessageOf = (error: unknown): string | undefined => {
  if (error instanceof TechnicalError) {
    return error.name;
  }
  if (isDriverError(error)) {
    return nameOf(error);
  }
  return error instanceof Error ? error.message : undefined;
};

interface SafeLogArguments {
  readonly fields: object;
  readonly message: string;
}

const safeLogArguments = (args: readonly unknown[]): SafeLogArguments | undefined => {
  const [first, second] = args;
  if (second !== undefined) {
    return undefined;
  }
  if (first instanceof Error) {
    const message = safeMessageOf(first);
    return message === undefined ? undefined : { fields: { err: first }, message };
  }
  if (isRecord(first) && first.err !== undefined && first.message === undefined) {
    const message = safeMessageOf(first.err);
    return message === undefined ? undefined : { fields: first, message };
  }
  return undefined;
};

export const buildLoggerOptions = (settings: LoggerSettings): LoggerOptions => ({
  level: settings.level,
  messageKey: 'message',
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: settings.service, instanceId: settings.instanceId },
  mixin: () => ({ ...requestContext.current() }),
  redact: { paths: [...REDACTED_PATHS], censor: '[REDACTED]' },
  serializers: { err: serializeError },
  hooks: {
    logMethod(inputArgs, method) {
      const safe = safeLogArguments(inputArgs);
      if (safe === undefined) {
        method.apply(this, inputArgs);
        return;
      }
      method.call(this, safe.fields, safe.message);
    },
  },
});

export const createLogger = (settings: LoggerSettings, destination?: DestinationStream): Logger =>
  destination === undefined
    ? pino(buildLoggerOptions(settings))
    : pino(buildLoggerOptions(settings), destination);
