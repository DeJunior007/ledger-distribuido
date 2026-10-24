import { InvalidIdempotencyTransitionError } from './errors/invalid-idempotency-transition.error';
import type { ProblemBody, TransactionResultBody } from './response-bodies';

export type StoredHttpStatus = 200 | 202 | 409 | 422 | 500;

export interface IdempotencyRecordState {
  providerId: string;
  idempotencyKey: string;
  payloadHash: string;
  transactionId: string | undefined;
  httpStatus: StoredHttpStatus;
  responseBody: TransactionResultBody | ProblemBody;
  createdAt: Date;
  updatedAt: Date;
}

export class IdempotencyRecord {
  private constructor(private state: IdempotencyRecordState) {}

  static create(props: Omit<IdempotencyRecordState, 'updatedAt'>): IdempotencyRecord {
    return new IdempotencyRecord({
      ...props,
      responseBody: { ...props.responseBody, idempotentReplay: false },
      updatedAt: props.createdAt,
    });
  }

  static rehydrate(state: IdempotencyRecordState): IdempotencyRecord {
    return new IdempotencyRecord({ ...state });
  }

  matches(payloadHash: string): boolean {
    return this.state.payloadHash === payloadHash;
  }

  toReplay(): { httpStatus: StoredHttpStatus; body: TransactionResultBody | ProblemBody } {
    return {
      httpStatus: this.state.httpStatus,
      body: { ...this.state.responseBody, idempotentReplay: true },
    };
  }

  resolve(props: {
    httpStatus: 200 | 422 | 500;
    responseBody: TransactionResultBody;
    at: Date;
  }): void {
    if (this.state.httpStatus !== 202) {
      throw new InvalidIdempotencyTransitionError(
        `Cannot resolve idempotency record with status ${String(this.state.httpStatus)}`,
      );
    }
    this.state = {
      ...this.state,
      httpStatus: props.httpStatus,
      responseBody: { ...props.responseBody, idempotentReplay: false },
      updatedAt: props.at,
    };
  }

  toState(): IdempotencyRecordState {
    return { ...this.state };
  }
}
