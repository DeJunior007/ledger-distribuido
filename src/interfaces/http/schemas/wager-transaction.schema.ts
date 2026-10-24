import { z } from 'zod';
import { CURRENCY_CODE_PATTERN } from '@domain/shared/currency';
import { FailureCode } from '@domain/shared/failure-code';
import type { MoneyProps } from '@domain/shared/money';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';

export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
export const EXTERNAL_ID_PATTERN = /^[\x21-\x7E]{1,128}$/;
export const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{1,255}$/;
export const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const MONEY_AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})\.\d{2}$/;

const ZERO_AMOUNT = '0.00';

export type RequestWagerKind = Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;

export interface WagerTransactionBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: RequestWagerKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

export interface WagerTransactionRequest {
  idempotencyKey: string;
  body: WagerTransactionBody;
}

export interface WagerTransactionData extends WagerTransactionBody {
  idempotencyKey: string;
}

const NON_ZERO_KINDS: readonly RequestWagerKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

const REVERSAL_KINDS: readonly RequestWagerKind[] = [
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

export const uuidSchema = z
  .string()
  .regex(UUID_PATTERN)
  .transform((value) => value.toLowerCase());

export const idempotencyKeySchema = z.string().regex(IDEMPOTENCY_KEY_PATTERN);

const externalIdSchema = z.string().regex(EXTERNAL_ID_PATTERN);

const kindSchema = z.enum([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

export const moneySchema = (
  supportedCurrencies: readonly string[],
): z.ZodType<MoneyProps, z.ZodTypeDef, unknown> =>
  z
    .object({
      amount: z.string().regex(MONEY_AMOUNT_PATTERN),
      currency: z.string().regex(CURRENCY_CODE_PATTERN),
    })
    .strict()
    .superRefine((money, context) => {
      if (
        CURRENCY_CODE_PATTERN.test(money.currency) &&
        !supportedCurrencies.includes(money.currency)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['currency'],
          message: 'currency is not supported',
          params: { failureCode: FailureCode.UnsupportedCurrency },
        });
      }
    });

const wagerTransactionShape = (supportedCurrencies: readonly string[]) => ({
  providerId: z.string().regex(PROVIDER_ID_PATTERN),
  externalTransactionId: externalIdSchema,
  playerId: uuidSchema,
  walletId: uuidSchema,
  roundId: externalIdSchema,
  gameId: externalIdSchema,
  kind: kindSchema,
  money: moneySchema(supportedCurrencies),
  referenceExternalTransactionId: externalIdSchema.optional(),
});

const ownField = (source: unknown, key: string): unknown =>
  typeof source === 'object' && source !== null
    ? Object.getOwnPropertyDescriptor(source, key)?.value
    : undefined;

const isOneOf = (value: unknown, kinds: readonly RequestWagerKind[]): boolean =>
  kinds.some((kind) => kind === value);

const checkCrossFieldRules = (raw: unknown, context: z.RefinementCtx): unknown => {
  const kind = ownField(raw, 'kind');
  const amount = ownField(ownField(raw, 'money'), 'amount');
  const reference = ownField(raw, 'referenceExternalTransactionId');
  const externalTransactionId = ownField(raw, 'externalTransactionId');
  if (isOneOf(kind, NON_ZERO_KINDS) && amount === ZERO_AMOUNT) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['money', 'amount'],
      message: 'amount must be greater than zero for this kind',
      params: { failureCode: FailureCode.InvalidAmount },
    });
  }
  if (isOneOf(kind, REVERSAL_KINDS) && reference === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['referenceExternalTransactionId'],
      message: 'referenceExternalTransactionId is required for this kind',
      params: { failureCode: FailureCode.ReferenceRequired },
    });
  }
  if (kind === WagerTransactionKind.Bet && reference !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['referenceExternalTransactionId'],
      message: 'referenceExternalTransactionId is not allowed for BET',
    });
  }
  if (reference !== undefined && reference === externalTransactionId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['referenceExternalTransactionId'],
      message: 'referenceExternalTransactionId must differ from externalTransactionId',
    });
  }
  return raw;
};

export const wagerTransactionBodySchema = (
  supportedCurrencies: readonly string[],
): z.ZodType<WagerTransactionBody, z.ZodTypeDef, unknown> =>
  z.preprocess(checkCrossFieldRules, z.object(wagerTransactionShape(supportedCurrencies)).strict());

export const wagerTransactionRequestSchema = (
  supportedCurrencies: readonly string[],
): z.ZodType<WagerTransactionRequest, z.ZodTypeDef, unknown> =>
  z
    .object({
      idempotencyKey: idempotencyKeySchema,
      body: wagerTransactionBodySchema(supportedCurrencies),
    })
    .strict();

export const wagerTransactionDataSchema = (
  supportedCurrencies: readonly string[],
): z.ZodType<WagerTransactionData, z.ZodTypeDef, unknown> =>
  z.preprocess(
    checkCrossFieldRules,
    z
      .object({
        ...wagerTransactionShape(supportedCurrencies),
        idempotencyKey: idempotencyKeySchema,
      })
      .strict(),
  );
