import { describe, expect, it } from 'bun:test';
import type { SubmitWagerTransactionCommand } from '@application/commands/submit-wager-transaction.command';
import { TRUSTED_CHANNEL } from '@application/ports/provider-identity.port';
import { canonicalJson } from '@application/services/canonical-json';
import {
  computeInboxHash,
  computeOpeningPayloadHash,
  computePayloadHash,
  computeRawBodyHash,
  idempotencyHashInput,
} from '@application/services/payload-hash';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { Sha256Hasher } from '@infrastructure/system/sha256-hasher';

const hasher = new Sha256Hasher();

const v1Command: SubmitWagerTransactionCommand = {
  channel: 'http',
  identity: { kind: 'provider', providerId: 'provider-a', clientId: 'provider-a-client' },
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  idempotencyKey: 'provider-a:transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: WagerTransactionKind.Bet,
  money: { amount: '25.00', currency: 'BRL' },
  referenceExternalTransactionId: undefined,
  correlationId: 'correlation-1',
  causationId: 'causation-1',
  inbox: undefined,
};

const v1Canonical =
  '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}';

const v3Canonical =
  '{"externalTransactionId":"transaction-124","gameId":"fortune-chimp","kind":"REFUND","money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","providerId":"provider-a","referenceExternalTransactionId":"transaction-123","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}';

const v4Canonical =
  '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","idempotencyKey":"provider-a:transaction-123","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}';

const V1_HASH = '629836932b79106b99523d06a1e7fa80689b0ea1e1c47aa3f0a5a2c87d0c4344';
const V2_HASH = 'c9ed351b8a19da7fd01217be5108ead3a429bd94bd5b63947a4a8d943b2a845d';
const V3_HASH = 'd47ad676d378f74510e611ad37b85a3c29e7bbbb3b987f6bfd65d67d28f68434';
const V4_HASH = 'a0b23737e20f6776c26497494deed2206e9418b3fd3a9dc43203c34866b05244';

describe('payload hashes', () => {
  it('produces the exact V1 canonical json and payload hash', () => {
    expect(canonicalJson(idempotencyHashInput(v1Command))).toBe(v1Canonical);
    expect(computePayloadHash(v1Command, hasher)).toBe(V1_HASH);
  });

  it('produces the exact V2 payload hash when only the amount changes', () => {
    const v2Command: SubmitWagerTransactionCommand = {
      ...v1Command,
      money: { amount: '25.01', currency: 'BRL' },
    };
    expect(computePayloadHash(v2Command, hasher)).toBe(V2_HASH);
    expect(V2_HASH).not.toBe(V1_HASH);
  });

  it('produces the exact V3 canonical json and payload hash for a refund with reference', () => {
    const v3Command: SubmitWagerTransactionCommand = {
      ...v1Command,
      externalTransactionId: 'transaction-124',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'transaction-123',
    };
    expect(canonicalJson(idempotencyHashInput(v3Command))).toBe(v3Canonical);
    expect(computePayloadHash(v3Command, hasher)).toBe(V3_HASH);
  });

  it('produces the exact V4 inbox hash for the V1 data with its idempotency key', () => {
    const data = {
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      idempotencyKey: 'provider-a:transaction-123',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };
    expect(canonicalJson(data)).toBe(v4Canonical);
    expect(computeInboxHash(data, hasher)).toBe(V4_HASH);
  });

  it('produces the V1 hash when the input keys arrive in reverse order (V5)', () => {
    const reversed: SubmitWagerTransactionCommand = {
      inbox: undefined,
      causationId: 'causation-1',
      correlationId: 'correlation-1',
      referenceExternalTransactionId: undefined,
      money: { currency: 'BRL', amount: '25.00' },
      kind: WagerTransactionKind.Bet,
      gameId: 'fortune-chimp',
      roundId: 'round-987',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      idempotencyKey: 'provider-a:transaction-123',
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
      identity: { clientId: 'provider-a-client', providerId: 'provider-a', kind: 'provider' },
      channel: 'http',
    };
    expect(computePayloadHash(reversed, hasher)).toBe(V1_HASH);
    expect(
      computeInboxHash(
        {
          money: { currency: 'BRL', amount: '25.00' },
          walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
          roundId: 'round-987',
          providerId: 'provider-a',
          playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
          kind: 'BET',
          idempotencyKey: 'provider-a:transaction-123',
          gameId: 'fortune-chimp',
          externalTransactionId: 'transaction-123',
        },
        hasher,
      ),
    ).toBe(V4_HASH);
  });

  it('ignores the idempotency key, transport metadata and channel when hashing the payload', () => {
    const withTransport = {
      ...v1Command,
      channel: 'sqs' as const,
      identity: TRUSTED_CHANNEL,
      idempotencyKey: 'another-key',
      correlationId: 'correlation-2',
      causationId: 'causation-2',
      inbox: { messageId: 'message-1', payloadHash: V4_HASH },
      messageId: 'message-1',
      occurredAt: '2026-01-01T00:00:00.000Z',
      type: 'WagerTransactionRequested',
    };
    expect(computePayloadHash(withTransport, hasher)).toBe(V1_HASH);
  });

  it('hashes the opening payload from kind, wallet and money only', () => {
    const expected = hasher.sha256Hex(
      '{"kind":"OPENING","money":{"amount":"100.00","currency":"BRL"},"walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}',
    );
    expect(
      computeOpeningPayloadHash(
        {
          walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
          money: { amount: '100.00', currency: 'BRL' },
        },
        hasher,
      ),
    ).toBe(expected);
  });

  it('hashes the raw body as is', () => {
    expect(computeRawBodyHash('abc', hasher)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('returns lowercase hex with 64 characters', () => {
    expect(computePayloadHash(v1Command, hasher)).toMatch(/^[0-9a-f]{64}$/);
  });
});
