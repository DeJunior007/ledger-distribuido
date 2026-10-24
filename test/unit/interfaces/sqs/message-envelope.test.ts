import { describe, expect, it } from 'bun:test';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { loadConfig } from '@infrastructure/config/env.schema';
import {
  readEnvelopeMessageId,
  wagerTransactionEnvelopeSchema,
} from '@interfaces/sqs/message-envelope.schema';

const supportedCurrencies = loadConfig(
  { DATABASE_URL: 'postgres://app:secret@localhost:5432/jungle' },
  { role: 'consumer' },
).SUPPORTED_CURRENCIES;

const schema = wagerTransactionEnvelopeSchema(supportedCurrencies);

const challengeData = (): Record<string, unknown> => ({
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  idempotencyKey: 'provider-a:transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
});

const challengeEnvelope = (
  data: Record<string, unknown> = challengeData(),
): Record<string, unknown> => ({
  messageId: 'msg-123',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data,
});

const withData = (overrides: Record<string, unknown>): Record<string, unknown> =>
  challengeEnvelope({ ...challengeData(), ...overrides });

describe('wagerTransactionEnvelopeSchema', () => {
  it('accepts the envelope from the challenge', () => {
    const parsed = schema.safeParse(challengeEnvelope());

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({
      messageId: 'msg-123',
      type: 'WagerTransactionRequested',
      occurredAt: '2026-07-29T15:00:00.000Z',
      data: {
        providerId: 'provider-a',
        externalTransactionId: 'transaction-123',
        idempotencyKey: 'provider-a:transaction-123',
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
        walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount: '25.00', currency: 'BRL' },
      },
    });
  });

  it('accepts an occurredAt with a timezone offset', () => {
    const parsed = schema.safeParse({
      ...challengeEnvelope(),
      occurredAt: '2026-07-29T12:00:00.000-03:00',
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects the OPENING kind', () => {
    expect(schema.safeParse(withData({ kind: 'OPENING' })).success).toBe(false);
  });

  it('rejects the reserved __system__ provider', () => {
    expect(schema.safeParse(withData({ providerId: '__system__' })).success).toBe(false);
  });

  it('rejects a null envelope', () => {
    expect(schema.safeParse(null).success).toBe(false);
  });

  it('rejects a null data', () => {
    expect(schema.safeParse({ ...challengeEnvelope(), data: null }).success).toBe(false);
  });

  it('rejects a null field inside data', () => {
    expect(schema.safeParse(withData({ referenceExternalTransactionId: null })).success).toBe(
      false,
    );
    expect(schema.safeParse(withData({ idempotencyKey: null })).success).toBe(false);
  });

  it('rejects an extra field on the envelope', () => {
    expect(schema.safeParse({ ...challengeEnvelope(), extra: 'x' }).success).toBe(false);
  });

  it('rejects an extra field inside data', () => {
    expect(schema.safeParse(withData({ extra: 'x' })).success).toBe(false);
  });

  it('rejects a numeric amount', () => {
    expect(schema.safeParse(withData({ money: { amount: 25, currency: 'BRL' } })).success).toBe(
      false,
    );
  });

  it('rejects a missing idempotencyKey', () => {
    const data = challengeData();
    delete data.idempotencyKey;

    expect(schema.safeParse(challengeEnvelope(data)).success).toBe(false);
  });

  it('rejects another message type', () => {
    expect(schema.safeParse({ ...challengeEnvelope(), type: 'WalletCreated' }).success).toBe(false);
  });

  it('rejects an occurredAt that is not an ISO datetime', () => {
    expect(schema.safeParse({ ...challengeEnvelope(), occurredAt: '29/07/2026' }).success).toBe(
      false,
    );
  });

  it('rejects a messageId outside printable ASCII or longer than 128 characters', () => {
    expect(schema.safeParse({ ...challengeEnvelope(), messageId: 'msg 123' }).success).toBe(false);
    expect(schema.safeParse({ ...challengeEnvelope(), messageId: 'm'.repeat(129) }).success).toBe(
      false,
    );
    expect(schema.safeParse({ ...challengeEnvelope(), messageId: 'm'.repeat(128) }).success).toBe(
      true,
    );
  });

  it('applies the same cross field rules as the HTTP body', () => {
    expect(schema.safeParse(withData({ money: { amount: '0.00', currency: 'BRL' } })).success).toBe(
      false,
    );
    expect(schema.safeParse(withData({ kind: 'REFUND' })).success).toBe(false);
    expect(
      schema.safeParse(withData({ referenceExternalTransactionId: 'transaction-123' })).success,
    ).toBe(false);
  });
});

describe('readEnvelopeMessageId', () => {
  it('returns the messageId of a readable envelope', () => {
    expect(readEnvelopeMessageId(JSON.stringify(challengeEnvelope()))).toBe('msg-123');
  });

  it('returns the messageId even when the rest of the envelope is invalid', () => {
    expect(readEnvelopeMessageId(JSON.stringify(withData({ kind: 'OPENING' })))).toBe('msg-123');
  });

  it('returns undefined for a body that is not JSON', () => {
    expect(readEnvelopeMessageId('not-json{')).toBeUndefined();
  });

  it('returns undefined for JSON without a valid messageId', () => {
    expect(readEnvelopeMessageId('null')).toBeUndefined();
    expect(readEnvelopeMessageId(JSON.stringify({ messageId: 42 }))).toBeUndefined();
    expect(readEnvelopeMessageId(JSON.stringify({ messageId: 'with space' }))).toBeUndefined();
  });

  it('returns undefined for a missing body', () => {
    expect(readEnvelopeMessageId(undefined)).toBeUndefined();
  });
});
