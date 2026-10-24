import { ErrorClass, TechnicalError } from '@application/errors/error-class';

export type SqsErrorOutcome =
  { readonly kind: 'shutdown' } | { readonly kind: 'failure'; readonly error: TechnicalError };

export interface SqsErrorContext {
  readonly shuttingDown: boolean;
}

export interface SqsBatchEntryFailure {
  readonly SenderFault?: boolean | undefined;
}

const CONNECTIVITY_NAMES: readonly string[] = ['TimeoutError', 'RequestTimeout'];

const TRANSIENT_NAMES: readonly string[] = [
  'ThrottlingException',
  'RequestThrottled',
  'ServiceUnavailable',
  'KmsThrottled',
];

const PERMANENT_NAMES: readonly string[] = [
  'QueueDoesNotExist',
  'AWS.SimpleQueueService.NonExistentQueue',
  'AccessDenied',
  'InvalidParameterValue',
  'InvalidMessageContents',
  'MessageTooLong',
  'InvalidAttributeValue',
];

const NETWORK_CODES: readonly string[] = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'];

const NETWORK_MESSAGES: readonly string[] = ['socket hang up', ...NETWORK_CODES];

const SERVER_ERROR_STATUS = 500;

const stringProperty = (target: object, key: string): string | undefined => {
  const value: unknown = Reflect.get(target, key);
  return typeof value === 'string' ? value : undefined;
};

const httpStatusOf = (target: object): number | undefined => {
  const metadata: unknown = Reflect.get(target, '$metadata');
  if (typeof metadata !== 'object' || metadata === null) {
    return undefined;
  }
  const status: unknown = Reflect.get(metadata, 'httpStatusCode');
  return typeof status === 'number' ? status : undefined;
};

const connectivity = (cause: unknown): TechnicalError =>
  new TechnicalError(ErrorClass.Connectivity, 'connection', { cause, probe: 'queue' });

const transient = (cause: unknown): TechnicalError =>
  new TechnicalError(ErrorClass.Transient, 'queue_transient', { cause });

const permanent = (cause: unknown): TechnicalError =>
  new TechnicalError(ErrorClass.Permanent, 'queue_permanent', { cause });

const failure = (error: TechnicalError): SqsErrorOutcome => ({ kind: 'failure', error });

const classifyByName = (names: readonly string[], cause: unknown): TechnicalError | undefined => {
  if (names.some((name) => CONNECTIVITY_NAMES.includes(name))) {
    return connectivity(cause);
  }
  if (names.some((name) => TRANSIENT_NAMES.includes(name))) {
    return transient(cause);
  }
  if (names.some((name) => PERMANENT_NAMES.includes(name))) {
    return permanent(cause);
  }
  return undefined;
};

const isNetworkFailure = (error: Error): boolean => {
  const code = stringProperty(error, 'code');
  if (code !== undefined && NETWORK_CODES.includes(code)) {
    return true;
  }
  return NETWORK_MESSAGES.some((fragment) => error.message.includes(fragment));
};

const classify = (error: unknown, context: SqsErrorContext): SqsErrorOutcome => {
  if (!(error instanceof Error)) {
    return failure(transient(error));
  }
  if (error.name === 'AbortError' && context.shuttingDown) {
    return { kind: 'shutdown' };
  }
  const names = [error.name, stringProperty(error, 'Code')].filter(
    (name): name is string => name !== undefined,
  );
  const byName = classifyByName(names, error);
  if (byName !== undefined) {
    return failure(byName);
  }
  const status = httpStatusOf(error);
  if (status !== undefined && status >= SERVER_ERROR_STATUS) {
    return failure(transient(error));
  }
  return failure(isNetworkFailure(error) ? connectivity(error) : transient(error));
};

const classifyBatchEntry = (entry: SqsBatchEntryFailure): TechnicalError =>
  entry.SenderFault === true ? permanent(entry) : transient(entry);

export const sqsErrorClassifier = { classify, classifyBatchEntry } as const;
