import type { Ref } from '@mikro-orm/core';
import type { WagerTransactionRecord } from './wager-transactions.record';

export interface IdempotencyRecordRecordProps {
  providerId: string;
  idempotencyKey: string;
  payloadHash: string;
  transaction: Ref<WagerTransactionRecord> | null;
  httpStatus: number;
  responseBody: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export class IdempotencyRecordRecord {
  providerId: string;
  idempotencyKey: string;
  payloadHash: string;
  transaction: Ref<WagerTransactionRecord> | null;
  httpStatus: number;
  responseBody: unknown;
  createdAt: Date;
  updatedAt: Date;

  constructor(props: IdempotencyRecordRecordProps) {
    this.providerId = props.providerId;
    this.idempotencyKey = props.idempotencyKey;
    this.payloadHash = props.payloadHash;
    this.transaction = props.transaction;
    this.httpStatus = props.httpStatus;
    this.responseBody = props.responseBody;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }
}
