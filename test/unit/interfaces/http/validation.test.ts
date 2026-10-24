import { describe, expect, it } from 'bun:test';
import { FailureCode } from '@domain/shared/failure-code';
import { Money } from '@domain/shared/money';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { loadConfig } from '@infrastructure/config/env.schema';
import { createWalletSchema } from '@interfaces/http/schemas/create-wallet.schema';
import {
  encodeLedgerCursor,
  LEDGER_DEFAULT_LIMIT,
  ledgerQuerySchema,
} from '@interfaces/http/schemas/ledger-query.schema';
import {
  MONEY_AMOUNT_PATTERN,
  uuidSchema,
  wagerTransactionDataSchema,
  wagerTransactionRequestSchema,
} from '@interfaces/http/schemas/wager-transaction.schema';
import { RequestValidationError, ZodValidationPipe } from '@interfaces/http/zod-validation.pipe';

const supportedCurrencies = loadConfig(
  { DATABASE_URL: 'postgres://app:secret@localhost:5432/jungle' },
  { role: 'api' },
).SUPPORTED_CURRENCIES;

const transactionPipe = new ZodValidationPipe(
  wagerTransactionRequestSchema(supportedCurrencies),
  'body',
);
const walletPipe = new ZodValidationPipe(createWalletSchema(supportedCurrencies), 'root');
const ledgerPipe = new ZodValidationPipe(ledgerQuerySchema);
const uuidPipe = new ZodValidationPipe(uuidSchema);

const validBody = (): Record<string, unknown> => ({
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
});

const request = (
  body: unknown,
  header: { idempotencyKey: unknown } = { idempotencyKey: 'provider-a:transaction-123' },
): Record<string, unknown> => ({ idempotencyKey: header.idempotencyKey, body });

const withBody = (overrides: Record<string, unknown>): Record<string, unknown> =>
  request({ ...validBody(), ...overrides });

const failureOf = (run: () => unknown): RequestValidationError => {
  try {
    run();
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return error;
    }
    throw error;
  }
  return expect.unreachable('validation was expected to fail');
};

const transactionCode = (value: unknown): FailureCode =>
  failureOf(() => transactionPipe.transform(value)).failureCode;

const walletCode = (value: unknown): FailureCode =>
  failureOf(() => walletPipe.transform(value)).failureCode;

describe('wager transaction field rules', () => {
  it('accepts a valid request and normalizes uuids to lowercase', () => {
    const parsed = transactionPipe.transform(
      withBody({
        playerId: '0192F28F-5DC0-7D58-BDB2-814AD6A0F4A1',
        walletId: '0192F291-27DD-7D3F-8071-5F8685DEEF37',
      }),
    );
    expect(parsed.idempotencyKey).toBe('provider-a:transaction-123');
    expect(parsed.body.playerId).toBe('0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1');
    expect(parsed.body.walletId).toBe('0192f291-27dd-7d3f-8071-5f8685deef37');
    expect(parsed.body.money).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  it('validates providerId', () => {
    expect(() => transactionPipe.transform(withBody({ providerId: 'p1' }))).not.toThrow();
    expect(() =>
      transactionPipe.transform(withBody({ providerId: `a${'b'.repeat(62)}` })),
    ).not.toThrow();
    for (const providerId of ['Provider-A', 'a', '-provider', 'provider_a', `a${'b'.repeat(63)}`]) {
      expect(transactionCode(withBody({ providerId }))).toBe(FailureCode.InvalidPayload);
    }
  });

  for (const field of ['externalTransactionId', 'roundId', 'gameId']) {
    it(`validates ${field} as 1 to 128 printable ascii characters`, () => {
      expect(() => transactionPipe.transform(withBody({ [field]: '!~' }))).not.toThrow();
      expect(() => transactionPipe.transform(withBody({ [field]: 'x'.repeat(128) }))).not.toThrow();
      for (const value of ['', 'has space', 'x'.repeat(129), 'acentuação', 42]) {
        expect(transactionCode(withBody({ [field]: value }))).toBe(FailureCode.InvalidPayload);
      }
    });
  }

  it('validates referenceExternalTransactionId as 1 to 128 printable ascii characters', () => {
    expect(() =>
      transactionPipe.transform(
        withBody({ kind: 'REFUND', referenceExternalTransactionId: 'transaction-001' }),
      ),
    ).not.toThrow();
    for (const value of ['has space', 'x'.repeat(129), '']) {
      expect(
        transactionCode(withBody({ kind: 'REFUND', referenceExternalTransactionId: value })),
      ).toBe(FailureCode.InvalidPayload);
    }
  });

  for (const field of ['playerId', 'walletId']) {
    it(`validates ${field} as a uuid`, () => {
      expect(() =>
        transactionPipe.transform(withBody({ [field]: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1' })),
      ).not.toThrow();
      for (const value of ['not-a-uuid', '0192f28f5dc07d58bdb2814ad6a0f4a1', '', 7]) {
        expect(transactionCode(withBody({ [field]: value }))).toBe(FailureCode.InvalidPayload);
      }
    });
  }

  it('accepts every request kind', () => {
    for (const kind of [
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Loss,
    ] as const) {
      expect(transactionPipe.transform(withBody({ kind })).body.kind).toBe(kind);
    }
    for (const kind of [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] as const) {
      expect(
        transactionPipe.transform(
          withBody({ kind, referenceExternalTransactionId: 'transaction-1' }),
        ).body.kind,
      ).toBe(kind);
    }
  });

  it('rejects an unknown, OPENING or missing kind with UNSUPPORTED_KIND', () => {
    expect(transactionCode(withBody({ kind: 'OPENING' }))).toBe(FailureCode.UnsupportedKind);
    expect(transactionCode(withBody({ kind: 'bet' }))).toBe(FailureCode.UnsupportedKind);
    expect(transactionCode(withBody({ kind: 1 }))).toBe(FailureCode.UnsupportedKind);
    expect(transactionCode(withBody({ kind: undefined }))).toBe(FailureCode.UnsupportedKind);
  });

  it('validates money.amount with the Money.from format', () => {
    for (const amount of ['0.05', '25.00', '999999999999999999.99']) {
      expect(() =>
        transactionPipe.transform(withBody({ money: { amount, currency: 'BRL' } })),
      ).not.toThrow();
    }
    for (const amount of [
      '25',
      '25.0',
      '25.000',
      '-1.00',
      '01.00',
      '1,00',
      '1000000000000000000.00',
    ]) {
      expect(transactionCode(withBody({ money: { amount, currency: 'BRL' } }))).toBe(
        FailureCode.InvalidMoney,
      );
    }
  });

  it('keeps the amount pattern aligned with Money.from', () => {
    for (const amount of ['0.00', '0.05', '25.00', '25', '-1.00', '01.00', '1.5']) {
      const acceptedByMoney = ((): boolean => {
        try {
          Money.from({ amount, currency: 'BRL' });
          return true;
        } catch {
          return false;
        }
      })();
      expect(MONEY_AMOUNT_PATTERN.test(amount)).toBe(acceptedByMoney);
    }
  });

  it('rejects a numeric amount without coercion', () => {
    expect(transactionCode(withBody({ money: { amount: 25, currency: 'BRL' } }))).toBe(
      FailureCode.InvalidMoney,
    );
  });

  it('validates the money.currency format', () => {
    for (const currency of ['brl', 'BR', 'BRLL', 'B1L', 986]) {
      expect(transactionCode(withBody({ money: { amount: '25.00', currency } }))).toBe(
        FailureCode.InvalidMoney,
      );
    }
  });

  it('rejects a currency outside SUPPORTED_CURRENCIES', () => {
    for (const currency of ['BRL', 'USD', 'EUR']) {
      expect(() =>
        transactionPipe.transform(withBody({ money: { amount: '25.00', currency } })),
      ).not.toThrow();
    }
    expect(transactionCode(withBody({ money: { amount: '25.00', currency: 'JPY' } }))).toBe(
      FailureCode.UnsupportedCurrency,
    );
  });

  it('requires a reference on REFUND and ROLLBACK', () => {
    expect(transactionCode(withBody({ kind: 'REFUND' }))).toBe(FailureCode.ReferenceRequired);
    expect(transactionCode(withBody({ kind: 'ROLLBACK' }))).toBe(FailureCode.ReferenceRequired);
  });

  it('forbids a reference on BET and allows it on WIN and LOSS', () => {
    expect(transactionCode(withBody({ referenceExternalTransactionId: 'transaction-1' }))).toBe(
      FailureCode.InvalidPayload,
    );
    for (const kind of ['WIN', 'LOSS']) {
      expect(() =>
        transactionPipe.transform(
          withBody({ kind, referenceExternalTransactionId: 'transaction-1' }),
        ),
      ).not.toThrow();
    }
  });

  it('rejects a self reference', () => {
    expect(
      transactionCode(
        withBody({ kind: 'REFUND', referenceExternalTransactionId: 'transaction-123' }),
      ),
    ).toBe(FailureCode.InvalidPayload);
  });

  it('rejects a zero amount on BET, WIN, REFUND and ROLLBACK and accepts it on LOSS', () => {
    const zero = { amount: '0.00', currency: 'BRL' };
    expect(transactionCode(withBody({ money: zero }))).toBe(FailureCode.InvalidAmount);
    expect(transactionCode(withBody({ kind: 'WIN', money: zero }))).toBe(FailureCode.InvalidAmount);
    for (const kind of ['REFUND', 'ROLLBACK']) {
      expect(
        transactionCode(withBody({ kind, money: zero, referenceExternalTransactionId: 'tx-1' })),
      ).toBe(FailureCode.InvalidAmount);
    }
    expect(() => transactionPipe.transform(withBody({ kind: 'LOSS', money: zero }))).not.toThrow();
  });

  it('validates the Idempotency-Key header', () => {
    expect(() =>
      transactionPipe.transform(request(validBody(), { idempotencyKey: 'k'.repeat(255) })),
    ).not.toThrow();
    for (const key of [undefined, '', 'has space', 'k'.repeat(256), ['a', 'b']]) {
      expect(transactionCode(request(validBody(), { idempotencyKey: key }))).toBe(
        FailureCode.MissingIdempotencyKey,
      );
    }
  });

  it('rejects unknown fields and null values', () => {
    expect(transactionCode(withBody({ extra: 'x' }))).toBe(FailureCode.InvalidPayload);
    expect(
      transactionCode(withBody({ money: { amount: '25.00', currency: 'BRL', scale: 2 } })),
    ).toBe(FailureCode.InvalidPayload);
    expect(transactionCode(withBody({ referenceExternalTransactionId: null }))).toBe(
      FailureCode.InvalidPayload,
    );
    expect(transactionCode(withBody({ gameId: null }))).toBe(FailureCode.InvalidPayload);
    expect(transactionCode(request(null))).toBe(FailureCode.InvalidPayload);
    expect(transactionCode(request(['BET']))).toBe(FailureCode.InvalidPayload);
  });
});

describe('failure code priority', () => {
  it('follows header > kind > money > currency > zero > reference > rest', () => {
    const steps: { value: Record<string, unknown>; expected: FailureCode }[] = [
      {
        value: request(
          {
            ...validBody(),
            kind: 'OPENING',
            money: { amount: '1', currency: 'JPY' },
            extra: true,
          },
          { idempotencyKey: undefined },
        ),
        expected: FailureCode.MissingIdempotencyKey,
      },
      {
        value: withBody({ kind: 'OPENING', money: { amount: '1', currency: 'brl' }, extra: true }),
        expected: FailureCode.UnsupportedKind,
      },
      {
        value: withBody({ kind: 'REFUND', money: { amount: '1', currency: 'JPY' }, extra: true }),
        expected: FailureCode.InvalidMoney,
      },
      {
        value: withBody({
          kind: 'REFUND',
          money: { amount: '0.00', currency: 'JPY' },
          extra: true,
        }),
        expected: FailureCode.UnsupportedCurrency,
      },
      {
        value: withBody({
          kind: 'REFUND',
          money: { amount: '0.00', currency: 'BRL' },
          extra: true,
        }),
        expected: FailureCode.InvalidAmount,
      },
      {
        value: withBody({ kind: 'REFUND', extra: true, gameId: '' }),
        expected: FailureCode.ReferenceRequired,
      },
      {
        value: withBody({ extra: true, gameId: '' }),
        expected: FailureCode.InvalidPayload,
      },
    ];
    for (const step of steps) {
      expect(transactionCode(step.value)).toBe(step.expected);
    }
  });

  it('keeps the reference rule ahead of invalid fields that abort the object', () => {
    expect(transactionCode(withBody({ kind: 'ROLLBACK', playerId: undefined }))).toBe(
      FailureCode.ReferenceRequired,
    );
  });
});

describe('errors list', () => {
  it('lists every problem with path and message', () => {
    const error = failureOf(() =>
      transactionPipe.transform(
        withBody({
          kind: 'REFUND',
          money: { amount: '0.00', currency: 'JPY' },
          gameId: '',
          extra: true,
        }),
      ),
    );
    const paths = error.errors.map((problem) => problem.path);
    expect(paths).toContain('body.money.amount');
    expect(paths).toContain('body.money.currency');
    expect(paths).toContain('body.referenceExternalTransactionId');
    expect(paths).toContain('body.gameId');
    expect(paths).toContain('body');
    expect(error.errors).toHaveLength(5);
    for (const problem of error.errors) {
      expect(problem.message.length).toBeGreaterThan(0);
    }
  });

  it('validates the header and the body together', () => {
    const error = failureOf(() =>
      transactionPipe.transform(request({ ...validBody(), roundId: '' }, { idempotencyKey: '' })),
    );
    expect(error.failureCode).toBe(FailureCode.MissingIdempotencyKey);
    expect(error.errors.map((problem) => problem.path)).toEqual(['idempotencyKey', 'body.roundId']);
  });

  it('carries a validation failure code for the error filter', () => {
    const error = failureOf(() => transactionPipe.transform(withBody({ kind: 'OPENING' })));
    expect(error.name).toBe('RequestValidationError');
    expect(error.failureCode).toBe(FailureCode.UnsupportedKind);
  });
});

describe('missing body', () => {
  it('returns INVALID_PAYLOAD before the priority table when the body is undefined', () => {
    for (const value of [
      request(undefined),
      request(undefined, { idempotencyKey: undefined }),
      {},
    ]) {
      const error = failureOf(() => transactionPipe.transform(value));
      expect(error.failureCode).toBe(FailureCode.InvalidPayload);
      expect(error.errors).toEqual([
        { path: 'body', message: 'request body must be a JSON document' },
      ]);
    }
  });

  it('returns INVALID_PAYLOAD for an undefined wallet body', () => {
    expect(walletCode(undefined)).toBe(FailureCode.InvalidPayload);
  });
});

describe('supported currencies whitelist', () => {
  it('comes from the configuration', () => {
    const customCurrencies = loadConfig(
      {
        DATABASE_URL: 'postgres://app:secret@localhost:5432/jungle',
        SUPPORTED_CURRENCIES: 'BRL,JPY',
      },
      { role: 'api' },
    ).SUPPORTED_CURRENCIES;
    const pipe = new ZodValidationPipe(wagerTransactionRequestSchema(customCurrencies), 'body');
    expect(
      pipe.transform(withBody({ money: { amount: '25.00', currency: 'JPY' } })).body.money.currency,
    ).toBe('JPY');
    expect(
      failureOf(() => pipe.transform(withBody({ money: { amount: '25.00', currency: 'USD' } })))
        .failureCode,
    ).toBe(FailureCode.UnsupportedCurrency);
  });
});

describe('queue data schema', () => {
  const dataSchema = wagerTransactionDataSchema(supportedCurrencies);

  it('accepts the http body plus idempotencyKey', () => {
    const parsed = dataSchema.parse({
      ...validBody(),
      idempotencyKey: 'provider-a:transaction-123',
    });
    expect(parsed.idempotencyKey).toBe('provider-a:transaction-123');
    expect(parsed.kind).toBe(WagerTransactionKind.Bet);
  });

  it('applies the same rules as the http body', () => {
    const pipe = new ZodValidationPipe(dataSchema);
    expect(failureOf(() => pipe.transform(validBody())).failureCode).toBe(
      FailureCode.MissingIdempotencyKey,
    );
    expect(
      failureOf(() => pipe.transform({ ...validBody(), idempotencyKey: 'key-1', kind: 'ROLLBACK' }))
        .failureCode,
    ).toBe(FailureCode.ReferenceRequired);
  });
});

describe('create wallet body', () => {
  const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

  it('accepts a zero or positive initial balance', () => {
    for (const amount of ['0.00', '1000.00']) {
      expect(
        walletPipe.transform({ playerId, initialBalance: { amount, currency: 'BRL' } }),
      ).toEqual({ playerId, initialBalance: { amount, currency: 'BRL' } });
    }
  });

  it('normalizes the playerId and rejects an invalid one', () => {
    expect(
      walletPipe.transform({
        playerId: playerId.toUpperCase(),
        initialBalance: { amount: '1.00', currency: 'BRL' },
      }).playerId,
    ).toBe(playerId);
    expect(walletCode({ playerId: 'x', initialBalance: { amount: '1.00', currency: 'BRL' } })).toBe(
      FailureCode.InvalidPayload,
    );
  });

  it('maps money problems to INVALID_MONEY and UNSUPPORTED_CURRENCY', () => {
    expect(walletCode({ playerId, initialBalance: { amount: '1', currency: 'BRL' } })).toBe(
      FailureCode.InvalidMoney,
    );
    expect(walletCode({ playerId, initialBalance: { amount: 1, currency: 'BRL' } })).toBe(
      FailureCode.InvalidMoney,
    );
    expect(walletCode({ playerId, initialBalance: { amount: '1.00', currency: 'brl' } })).toBe(
      FailureCode.InvalidMoney,
    );
    expect(walletCode({ playerId, initialBalance: { amount: '1.00', currency: 'JPY' } })).toBe(
      FailureCode.UnsupportedCurrency,
    );
  });

  it('rejects unknown fields and missing fields with INVALID_PAYLOAD', () => {
    expect(
      walletCode({ playerId, initialBalance: { amount: '1.00', currency: 'BRL' }, extra: 1 }),
    ).toBe(FailureCode.InvalidPayload);
    expect(walletCode({ playerId })).toBe(FailureCode.InvalidPayload);
    expect(walletCode({ playerId, initialBalance: null })).toBe(FailureCode.InvalidPayload);
  });
});

describe('ledger query', () => {
  const ledgerCode = (value: unknown): FailureCode =>
    failureOf(() => ledgerPipe.transform(value)).failureCode;

  it('defaults the limit to 50 without a cursor', () => {
    expect(ledgerPipe.transform({})).toEqual({
      beforeWalletVersion: undefined,
      limit: LEDGER_DEFAULT_LIMIT,
    });
  });

  it('accepts a limit between 1 and 200', () => {
    expect(ledgerPipe.transform({ limit: '1' }).limit).toBe(1);
    expect(ledgerPipe.transform({ limit: '200' }).limit).toBe(200);
    for (const limit of ['0', '201', 'abc', '1.5', '-1', '050', ['1', '2']]) {
      expect(ledgerCode({ limit })).toBe(FailureCode.InvalidPayload);
    }
  });

  it('decodes a cursor produced by encodeLedgerCursor', () => {
    const cursor = encodeLedgerCursor(2);
    expect(cursor).toBe('eyJ2IjoyfQ');
    expect(ledgerPipe.transform({ cursor, limit: '10' })).toEqual({
      beforeWalletVersion: 2,
      limit: 10,
    });
  });

  it('rejects an invalid cursor with INVALID_PAYLOAD', () => {
    const base64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');
    for (const cursor of [
      'not base64!',
      '',
      base64url('not json'),
      base64url('{"v":0}'),
      base64url('{"v":1.5}'),
      base64url('{"v":"2"}'),
      base64url('{"v":2,"x":1}'),
      base64url('{ "v": 2 }'),
    ]) {
      expect(ledgerCode({ cursor })).toBe(FailureCode.InvalidPayload);
    }
  });

  it('rejects unknown query parameters', () => {
    expect(ledgerCode({ offset: '10' })).toBe(FailureCode.InvalidPayload);
  });
});

describe('route uuid parameters', () => {
  it('accepts a uuid and rejects anything else with INVALID_PAYLOAD', () => {
    expect(uuidPipe.transform('0192F291-27DD-7D3F-8071-5F8685DEEF37')).toBe(
      '0192f291-27dd-7d3f-8071-5f8685deef37',
    );
    expect(failureOf(() => uuidPipe.transform('wallet-1')).failureCode).toBe(
      FailureCode.InvalidPayload,
    );
  });
});
