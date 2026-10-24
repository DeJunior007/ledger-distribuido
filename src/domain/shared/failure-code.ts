export enum FailureAction {
  Retry = 'RETRY',
  FixPayload = 'FIX_PAYLOAD',
  Reauthenticate = 'REAUTHENTICATE',
  GiveUp = 'GIVE_UP',
}

export enum FailureCategory {
  Validation = 'VALIDATION',
  Authentication = 'AUTHENTICATION',
  Authorization = 'AUTHORIZATION',
  NotFound = 'NOT_FOUND',
  Conflict = 'CONFLICT',
  Business = 'BUSINESS',
  Failed = 'FAILED',
  Infrastructure = 'INFRASTRUCTURE',
}

export enum FailureCode {
  InvalidPayload = 'INVALID_PAYLOAD',
  InvalidMoney = 'INVALID_MONEY',
  InvalidAmount = 'INVALID_AMOUNT',
  UnsupportedCurrency = 'UNSUPPORTED_CURRENCY',
  MissingIdempotencyKey = 'MISSING_IDEMPOTENCY_KEY',
  ReferenceRequired = 'REFERENCE_REQUIRED',
  UnsupportedKind = 'UNSUPPORTED_KIND',
  Unauthenticated = 'UNAUTHENTICATED',
  Forbidden = 'FORBIDDEN',
  ProviderIdentityMismatch = 'PROVIDER_IDENTITY_MISMATCH',
  NotFound = 'NOT_FOUND',
  IdempotencyKeyConflict = 'IDEMPOTENCY_KEY_CONFLICT',
  ExternalTransactionIdConflict = 'EXTERNAL_TRANSACTION_ID_CONFLICT',
  WalletAlreadyExists = 'WALLET_ALREADY_EXISTS',
  WalletNotFound = 'WALLET_NOT_FOUND',
  PlayerWalletMismatch = 'PLAYER_WALLET_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  InsufficientFundsForReversal = 'INSUFFICIENT_FUNDS_FOR_REVERSAL',
  BalanceLimitExceeded = 'BALANCE_LIMIT_EXCEEDED',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  AmountMismatch = 'AMOUNT_MISMATCH',
  ProcessingFailed = 'PROCESSING_FAILED',
  InternalError = 'INTERNAL_ERROR',
  InfrastructureUnavailable = 'INFRASTRUCTURE_UNAVAILABLE',
}

export interface FailureCodeMetadata {
  readonly category: FailureCategory;
  readonly httpStatus: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 503;
  readonly retryable: boolean;
  readonly action: FailureAction;
}

export const FAILURE_CODE_METADATA: Readonly<Record<FailureCode, FailureCodeMetadata>> = {
  [FailureCode.InvalidPayload]: {
    category: FailureCategory.Validation,
    httpStatus: 400,
    retryable: false,
    action: FailureAction.FixPayload,
  },
  [FailureCode.InvalidMoney]: {
    category: FailureCategory.Validation,
    httpStatus: 400,
    retryable: false,
    action: FailureAction.FixPayload,
  },
  [FailureCode.InvalidAmount]: {
    category: FailureCategory.Validation,
    httpStatus: 400,
    retryable: false,
    action: FailureAction.FixPayload,
  },
  [FailureCode.UnsupportedCurrency]: {
    category: FailureCategory.Validation,
    httpStatus: 400,
    retryable: false,
    action: FailureAction.FixPayload,
  },
  [FailureCode.MissingIdempotencyKey]: {
    category: FailureCategory.Validation,
    httpStatus: 400,
    retryable: false,
    action: FailureAction.FixPayload,
  },
  [FailureCode.ReferenceRequired]: {
    category: FailureCategory.Validation,
    httpStatus: 400,
    retryable: false,
    action: FailureAction.FixPayload,
  },
  [FailureCode.UnsupportedKind]: {
    category: FailureCategory.Validation,
    httpStatus: 400,
    retryable: false,
    action: FailureAction.FixPayload,
  },
  [FailureCode.Unauthenticated]: {
    category: FailureCategory.Authentication,
    httpStatus: 401,
    retryable: true,
    action: FailureAction.Reauthenticate,
  },
  [FailureCode.Forbidden]: {
    category: FailureCategory.Authorization,
    httpStatus: 403,
    retryable: false,
    action: FailureAction.GiveUp,
  },
  [FailureCode.ProviderIdentityMismatch]: {
    category: FailureCategory.Authorization,
    httpStatus: 403,
    retryable: false,
    action: FailureAction.FixPayload,
  },
  [FailureCode.NotFound]: {
    category: FailureCategory.NotFound,
    httpStatus: 404,
    retryable: false,
    action: FailureAction.GiveUp,
  },
  [FailureCode.IdempotencyKeyConflict]: {
    category: FailureCategory.Conflict,
    httpStatus: 409,
    retryable: false,
    action: FailureAction.FixPayload,
  },
  [FailureCode.ExternalTransactionIdConflict]: {
    category: FailureCategory.Conflict,
    httpStatus: 409,
    retryable: false,
    action: FailureAction.FixPayload,
  },
  [FailureCode.WalletAlreadyExists]: {
    category: FailureCategory.Conflict,
    httpStatus: 409,
    retryable: false,
    action: FailureAction.GiveUp,
  },
  [FailureCode.WalletNotFound]: {
    category: FailureCategory.Business,
    httpStatus: 422,
    retryable: false,
    action: FailureAction.GiveUp,
  },
  [FailureCode.PlayerWalletMismatch]: {
    category: FailureCategory.Business,
    httpStatus: 422,
    retryable: false,
    action: FailureAction.GiveUp,
  },
  [FailureCode.CurrencyMismatch]: {
    category: FailureCategory.Business,
    httpStatus: 422,
    retryable: false,
    action: FailureAction.GiveUp,
  },
  [FailureCode.InsufficientFunds]: {
    category: FailureCategory.Business,
    httpStatus: 422,
    retryable: false,
    action: FailureAction.GiveUp,
  },
  [FailureCode.InsufficientFundsForReversal]: {
    category: FailureCategory.Business,
    httpStatus: 422,
    retryable: false,
    action: FailureAction.GiveUp,
  },
  [FailureCode.BalanceLimitExceeded]: {
    category: FailureCategory.Business,
    httpStatus: 422,
    retryable: false,
    action: FailureAction.GiveUp,
  },
  [FailureCode.ReferenceNotFound]: {
    category: FailureCategory.Business,
    httpStatus: 422,
    retryable: false,
    action: FailureAction.GiveUp,
  },
  [FailureCode.ReferenceMismatch]: {
    category: FailureCategory.Business,
    httpStatus: 422,
    retryable: false,
    action: FailureAction.GiveUp,
  },
  [FailureCode.InvalidReferenceKind]: {
    category: FailureCategory.Business,
    httpStatus: 422,
    retryable: false,
    action: FailureAction.GiveUp,
  },
  [FailureCode.ReferenceNotProcessed]: {
    category: FailureCategory.Business,
    httpStatus: 422,
    retryable: false,
    action: FailureAction.GiveUp,
  },
  [FailureCode.ReferenceAlreadyReversed]: {
    category: FailureCategory.Business,
    httpStatus: 422,
    retryable: false,
    action: FailureAction.GiveUp,
  },
  [FailureCode.AmountMismatch]: {
    category: FailureCategory.Business,
    httpStatus: 422,
    retryable: false,
    action: FailureAction.GiveUp,
  },
  [FailureCode.ProcessingFailed]: {
    category: FailureCategory.Failed,
    httpStatus: 500,
    retryable: false,
    action: FailureAction.GiveUp,
  },
  [FailureCode.InternalError]: {
    category: FailureCategory.Infrastructure,
    httpStatus: 503,
    retryable: true,
    action: FailureAction.Retry,
  },
  [FailureCode.InfrastructureUnavailable]: {
    category: FailureCategory.Infrastructure,
    httpStatus: 503,
    retryable: true,
    action: FailureAction.Retry,
  },
};

export const PERSISTED_REJECTION_CODES: readonly FailureCode[] = [
  FailureCode.PlayerWalletMismatch,
  FailureCode.CurrencyMismatch,
  FailureCode.InsufficientFunds,
  FailureCode.InsufficientFundsForReversal,
  FailureCode.BalanceLimitExceeded,
  FailureCode.ReferenceNotFound,
  FailureCode.ReferenceMismatch,
  FailureCode.InvalidReferenceKind,
  FailureCode.ReferenceNotProcessed,
  FailureCode.ReferenceAlreadyReversed,
  FailureCode.AmountMismatch,
];
