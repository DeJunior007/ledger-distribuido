import { ref } from '@mikro-orm/core';
import { IdempotencyRecord, type StoredHttpStatus } from '@domain/idempotency/idempotency-record';
import type { ProblemBody, TransactionResultBody } from '@domain/idempotency/response-bodies';
import { IdempotencyRecordRecord } from '../records/idempotency-records.record';
import { WagerTransactionRecord } from '../records/wager-transactions.record';
import { corruptedRow, isRecord } from './persisted-values.mapper';

const STORED_HTTP_STATUSES: readonly number[] = [200, 202, 409, 422, 500];

function isStoredHttpStatus(value: number): value is StoredHttpStatus {
  return STORED_HTTP_STATUSES.includes(value);
}

function isStoredBody(value: unknown): value is TransactionResultBody | ProblemBody {
  if (!isRecord(value)) {
    return false;
  }
  const isResult =
    typeof value.status === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.idempotentReplay === 'boolean';
  const isProblem =
    typeof value.type === 'string' &&
    typeof value.title === 'string' &&
    typeof value.status === 'number' &&
    typeof value.failureCode === 'string';
  return isResult || isProblem;
}

export function toDomain(record: IdempotencyRecordRecord): IdempotencyRecord {
  if (!isStoredHttpStatus(record.httpStatus) || !isStoredBody(record.responseBody)) {
    throw corruptedRow();
  }
  return IdempotencyRecord.rehydrate({
    providerId: record.providerId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    transactionId: record.transaction?.id ?? undefined,
    httpStatus: record.httpStatus,
    responseBody: record.responseBody,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function toRecord(
  idempotency: IdempotencyRecord,
  existing?: IdempotencyRecordRecord,
): IdempotencyRecordRecord {
  const state = idempotency.toState();
  const transaction =
    state.transactionId === undefined ? null : ref(WagerTransactionRecord, state.transactionId);
  if (existing !== undefined) {
    existing.httpStatus = state.httpStatus;
    existing.responseBody = state.responseBody;
    existing.updatedAt = state.updatedAt;
    if (existing.transaction?.id !== state.transactionId) {
      existing.transaction = transaction;
    }
    return existing;
  }
  return new IdempotencyRecordRecord({
    providerId: state.providerId,
    idempotencyKey: state.idempotencyKey,
    payloadHash: state.payloadHash,
    transaction,
    httpStatus: state.httpStatus,
    responseBody: state.responseBody,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  });
}
