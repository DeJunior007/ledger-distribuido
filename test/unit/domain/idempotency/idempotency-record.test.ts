import { describe, expect, it } from 'bun:test';
import { IdempotencyRecord, type StoredHttpStatus } from '@domain/idempotency/idempotency-record';
import { InvalidIdempotencyTransitionError } from '@domain/idempotency/errors/invalid-idempotency-transition.error';
import type { TransactionResultBody } from '@domain/idempotency/response-bodies';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';

const createdAt = new Date('2026-01-01T00:00:00.000Z');
const resolvedAt = new Date('2026-01-01T00:00:05.000Z');
const hashV1 = '11'.repeat(32);
const hashV2 = '22'.repeat(32);

function body(
  status: TransactionResultBody['status'],
  idempotentReplay = true,
): TransactionResultBody {
  return {
    transactionId: 'tx-1',
    status,
    kind: WagerTransactionKind.Bet,
    balance: null,
    idempotentReplay,
  };
}

function record(httpStatus: StoredHttpStatus, payloadHash = hashV1): IdempotencyRecord {
  return IdempotencyRecord.create({
    providerId: 'provider-1',
    idempotencyKey: 'key-1',
    payloadHash,
    transactionId: 'tx-1',
    httpStatus,
    responseBody: body('PENDING_REFERENCE'),
    createdAt,
  });
}

describe('IdempotencyRecord', () => {
  it('forces idempotentReplay false on create', () => {
    const state = record(202).toState();
    expect(state.responseBody.idempotentReplay).toBe(false);
    expect(state.updatedAt).toEqual(createdAt);
  });

  it('does not match a divergent payload hash', () => {
    const stored = record(200, hashV1);
    expect(stored.matches(hashV1)).toBe(true);
    expect(stored.matches(hashV2)).toBe(false);
  });

  it('replays a copy with idempotentReplay true without changing state', () => {
    const stored = record(200);
    const before = stored.toState();
    const replay = stored.toReplay();
    expect(replay.httpStatus).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(stored.toState()).toEqual(before);
    expect(stored.toState().responseBody.idempotentReplay).toBe(false);
  });

  it.each([200, 422, 500] as const)('resolves from 202 to %i', (httpStatus) => {
    const stored = record(202);
    stored.resolve({ httpStatus, responseBody: body('PROCESSED'), at: resolvedAt });
    const state = stored.toState();
    expect(state.httpStatus).toBe(httpStatus);
    expect(state.responseBody.idempotentReplay).toBe(false);
    expect(state.updatedAt).toEqual(resolvedAt);
  });

  it.each([200, 409, 422, 500] as const)('refuses to resolve from %i', (httpStatus) => {
    const stored = record(httpStatus);
    expect(() => {
      stored.resolve({ httpStatus: 200, responseBody: body('PROCESSED'), at: resolvedAt });
    }).toThrow(InvalidIdempotencyTransitionError);
  });

  it('rehydrates a 200 record without validating', () => {
    const state = record(200).toState();
    const rehydrated = IdempotencyRecord.rehydrate(state);
    expect(rehydrated.toState()).toEqual(state);
  });
});
