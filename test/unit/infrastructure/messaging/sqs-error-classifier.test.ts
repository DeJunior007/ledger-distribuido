import { describe, expect, it } from 'bun:test';
import { ErrorClass, TechnicalError, classifyError } from '@application/errors/error-class';
import { sqsErrorClassifier } from '@infrastructure/messaging/sqs-error-classifier';
import type { SqsErrorOutcome } from '@infrastructure/messaging/sqs-error-classifier';

const running = { shuttingDown: false };
const stopping = { shuttingDown: true };

const namedError = (name: string, extra: Record<string, unknown> = {}): Error =>
  Object.assign(new Error(`${name} raised`), { name }, extra);

const serviceError = (name: string, httpStatusCode: number, code?: string): Error =>
  namedError(name, {
    $metadata: { httpStatusCode },
    ...(code === undefined ? {} : { Code: code }),
  });

const networkError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

const failureOf = (outcome: SqsErrorOutcome): TechnicalError => {
  if (outcome.kind !== 'failure') {
    throw new TypeError(`expected a failure, got ${outcome.kind}`);
  }
  return outcome.error;
};

const classOf = (error: unknown): ErrorClass =>
  classifyError(failureOf(sqsErrorClassifier.classify(error, running)));

describe('sqsErrorClassifier.classify', () => {
  it('ignores an AbortError raised during shutdown', () => {
    expect(sqsErrorClassifier.classify(namedError('AbortError'), stopping)).toEqual({
      kind: 'shutdown',
    });
  });

  it('treats an AbortError outside shutdown as transient', () => {
    expect(classOf(namedError('AbortError'))).toBe(ErrorClass.Transient);
  });

  it('classifies a generic network error by its code as connectivity', () => {
    const error = networkError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:1');
    expect(error.name).toBe('Error');
    expect(Reflect.get(error, '$metadata')).toBeUndefined();
    const failure = failureOf(sqsErrorClassifier.classify(error, running));
    expect(failure).toBeInstanceOf(TechnicalError);
    expect(failure.errorClass).toBe(ErrorClass.Connectivity);
    expect(failure.reason).toBe('connection');
    expect(failure.probe).toBe('queue');
    expect(failure.cause).toBe(error);
  });

  it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'])(
    'classifies the network code %s as connectivity',
    (code) => {
      expect(classOf(networkError(code, 'request failed'))).toBe(ErrorClass.Connectivity);
    },
  );

  it.each([
    'socket hang up',
    'connect ECONNREFUSED 127.0.0.1:4566',
    'read ECONNRESET',
    'connect ETIMEDOUT 10.0.0.1:4566',
    'getaddrinfo ENOTFOUND ministack',
  ])('classifies a generic error with message "%s" as connectivity', (message) => {
    expect(classOf(new Error(message))).toBe(ErrorClass.Connectivity);
  });

  it.each(['TimeoutError', 'RequestTimeout'])('classifies %s as connectivity', (name) => {
    const failure = failureOf(sqsErrorClassifier.classify(namedError(name), running));
    expect(failure.errorClass).toBe(ErrorClass.Connectivity);
    expect(failure.probe).toBe('queue');
  });

  it.each([500, 502, 503, 504])('classifies an HTTP %d response as transient', (status) => {
    const failure = failureOf(
      sqsErrorClassifier.classify(serviceError('InternalError', status), running),
    );
    expect(failure.errorClass).toBe(ErrorClass.Transient);
    expect(failure.reason).toBe('queue_transient');
    expect(failure.probe).toBeUndefined();
  });

  it.each(['ThrottlingException', 'RequestThrottled', 'ServiceUnavailable', 'KmsThrottled'])(
    'classifies %s as transient',
    (name) => {
      expect(classOf(serviceError(name, 400))).toBe(ErrorClass.Transient);
    },
  );

  it.each([
    'QueueDoesNotExist',
    'AccessDenied',
    'InvalidParameterValue',
    'InvalidMessageContents',
    'MessageTooLong',
    'InvalidAttributeValue',
  ])('classifies %s as permanent', (name) => {
    const failure = failureOf(sqsErrorClassifier.classify(serviceError(name, 400), running));
    expect(failure.errorClass).toBe(ErrorClass.Permanent);
    expect(failure.reason).toBe('queue_permanent');
  });

  it('classifies the NonExistentQueue body code as permanent', () => {
    const error = serviceError('UnknownError', 400, 'AWS.SimpleQueueService.NonExistentQueue');
    expect(classOf(error)).toBe(ErrorClass.Permanent);
  });

  it('classifies any other error as transient', () => {
    expect(classOf(serviceError('SomethingUnexpected', 400))).toBe(ErrorClass.Transient);
    expect(classOf(new Error('unexpected'))).toBe(ErrorClass.Transient);
    expect(classOf('not an error')).toBe(ErrorClass.Transient);
  });
});

describe('sqsErrorClassifier.classifyBatchEntry', () => {
  it('classifies an entry with SenderFault true as permanent', () => {
    const failure = sqsErrorClassifier.classifyBatchEntry({ SenderFault: true });
    expect(failure.errorClass).toBe(ErrorClass.Permanent);
    expect(failure.reason).toBe('queue_permanent');
  });

  it('classifies an entry with SenderFault false as transient', () => {
    const failure = sqsErrorClassifier.classifyBatchEntry({ SenderFault: false });
    expect(failure.errorClass).toBe(ErrorClass.Transient);
    expect(failure.reason).toBe('queue_transient');
  });
});
