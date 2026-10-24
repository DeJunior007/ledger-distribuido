import { FailureCode, PERSISTED_REJECTION_CODES } from '../shared/failure-code';
import { Money } from '../shared/money';
import { InvalidAmountError } from '../wallet/errors/invalid-amount.error';
import { InvalidLedgerPostingError } from '../wallet/errors/invalid-ledger-posting.error';
import { LedgerDirection, oppositeDirection } from '../wallet/ledger-direction';
import { InvalidPayloadError } from './errors/invalid-payload.error';
import { InvalidTransactionStateError } from './errors/invalid-transaction-state.error';
import { ReferenceRequiredError } from './errors/reference-required.error';
import { UnsupportedKindError } from './errors/unsupported-kind.error';
import { WagerTransactionKind } from './wager-transaction-kind';
import { WagerTransactionStatus } from './wager-transaction-status';

const SYSTEM_PROVIDER_ID = '__system__';
const OPENING_ROUND_ID = 'opening';

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  referenceTransactionId: string | undefined;
  status: WagerTransactionStatus;
  failureCode: FailureCode | undefined;
  balanceSnapshot: Money | undefined;
  correlationId: string;
  createdAt: Date;
  processedAt: Date | undefined;
  updatedAt: Date;
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  correlationId: string;
  now: Date;
}

export interface OpeningProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  payloadHash: string;
  correlationId: string;
  now: Date;
}

function assertCreatable(props: CreateWagerTransactionProps): void {
  if (props.kind === WagerTransactionKind.Opening) {
    throw new UnsupportedKindError('OPENING transactions cannot be created from requests');
  }
  if (props.providerId === SYSTEM_PROVIDER_ID) {
    throw new InvalidPayloadError('provider id is reserved for the system');
  }
  const hasReference = props.referenceExternalTransactionId !== undefined;
  const needsReference =
    props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
  if (needsReference && !hasReference) {
    throw new ReferenceRequiredError(`${props.kind} requires a reference`);
  }
  if (props.kind === WagerTransactionKind.Bet && hasReference) {
    throw new InvalidPayloadError('BET cannot carry a reference');
  }
  if (props.referenceExternalTransactionId === props.externalTransactionId) {
    throw new InvalidPayloadError('reference cannot point to the transaction itself');
  }
  if (props.kind === WagerTransactionKind.Loss) {
    if (props.money.isNegative()) {
      throw new InvalidAmountError('LOSS amount cannot be negative');
    }
  } else if (!props.money.isPositive()) {
    throw new InvalidAmountError(`${props.kind} amount must be positive`);
  }
}

export class WagerTransaction {
  private currentStatus: WagerTransactionStatus;
  private currentReferenceTransactionId: string | undefined;
  private currentFailureCode: FailureCode | undefined;
  private currentBalanceSnapshot: Money | undefined;
  private currentProcessedAt: Date | undefined;
  private currentUpdatedAt: Date;

  private constructor(
    readonly id: string,
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly idempotencyKey: string,
    readonly payloadHash: string,
    readonly walletId: string,
    readonly playerId: string,
    readonly roundId: string,
    readonly gameId: string,
    readonly kind: WagerTransactionKind,
    readonly money: Money,
    readonly referenceExternalTransactionId: string | undefined,
    readonly correlationId: string,
    readonly createdAt: Date,
    state: {
      status: WagerTransactionStatus;
      referenceTransactionId: string | undefined;
      failureCode: FailureCode | undefined;
      balanceSnapshot: Money | undefined;
      processedAt: Date | undefined;
      updatedAt: Date;
    },
  ) {
    this.currentStatus = state.status;
    this.currentReferenceTransactionId = state.referenceTransactionId;
    this.currentFailureCode = state.failureCode;
    this.currentBalanceSnapshot = state.balanceSnapshot;
    this.currentProcessedAt = state.processedAt;
    this.currentUpdatedAt = state.updatedAt;
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    assertCreatable(props);
    return WagerTransaction.build(props, {
      status: WagerTransactionStatus.Pending,
      failureCode: undefined,
      balanceSnapshot: undefined,
      processedAt: undefined,
    });
  }

  static opening(props: OpeningProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidAmountError('opening amount must be positive');
    }
    const key = `opening:${props.walletId}`;
    return new WagerTransaction(
      props.id,
      SYSTEM_PROVIDER_ID,
      key,
      key,
      props.payloadHash,
      props.walletId,
      props.playerId,
      OPENING_ROUND_ID,
      OPENING_ROUND_ID,
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      props.correlationId,
      props.now,
      {
        status: WagerTransactionStatus.Processed,
        referenceTransactionId: undefined,
        failureCode: undefined,
        balanceSnapshot: props.money,
        processedAt: props.now,
        updatedAt: props.now,
      },
    );
  }

  static failNew(
    props: CreateWagerTransactionProps & { balanceSnapshot: Money | undefined },
  ): WagerTransaction {
    assertCreatable(props);
    return WagerTransaction.build(props, {
      status: WagerTransactionStatus.Failed,
      failureCode: FailureCode.ProcessingFailed,
      balanceSnapshot: props.balanceSnapshot,
      processedAt: undefined,
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.correlationId,
      state.createdAt,
      {
        status: state.status,
        referenceTransactionId: state.referenceTransactionId,
        failureCode: state.failureCode,
        balanceSnapshot: state.balanceSnapshot,
        processedAt: state.processedAt,
        updatedAt: state.updatedAt,
      },
    );
  }

  private static build(
    props: CreateWagerTransactionProps,
    state: {
      status: WagerTransactionStatus;
      failureCode: FailureCode | undefined;
      balanceSnapshot: Money | undefined;
      processedAt: Date | undefined;
    },
  ): WagerTransaction {
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.correlationId,
      props.now,
      { ...state, referenceTransactionId: undefined, updatedAt: props.now },
    );
  }

  get status(): WagerTransactionStatus {
    return this.currentStatus;
  }

  get referenceTransactionId(): string | undefined {
    return this.currentReferenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this.currentFailureCode;
  }

  get processedAt(): Date | undefined {
    return this.currentProcessedAt;
  }

  get balanceSnapshot(): Money | undefined {
    return this.currentBalanceSnapshot;
  }

  get updatedAt(): Date {
    return this.currentUpdatedAt;
  }

  markProcessed(props: {
    referenceTransactionId: string | undefined;
    balanceSnapshot: Money;
    at: Date;
  }): void {
    this.assertOpen('PROCESSED');
    this.currentStatus = WagerTransactionStatus.Processed;
    this.currentReferenceTransactionId = props.referenceTransactionId;
    this.currentBalanceSnapshot = props.balanceSnapshot;
    this.currentProcessedAt = props.at;
    this.currentUpdatedAt = props.at;
  }

  markPendingReference(props: { balanceSnapshot: Money; at: Date }): void {
    if (this.currentStatus !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(
        `cannot move ${this.currentStatus} transaction to PENDING_REFERENCE`,
      );
    }
    this.currentStatus = WagerTransactionStatus.PendingReference;
    this.currentBalanceSnapshot = props.balanceSnapshot;
    this.currentUpdatedAt = props.at;
  }

  reject(props: {
    failureCode: FailureCode;
    referenceTransactionId: string | undefined;
    balanceSnapshot: Money | undefined;
    at: Date;
  }): void {
    this.assertOpen('REJECTED');
    if (!PERSISTED_REJECTION_CODES.includes(props.failureCode)) {
      throw new InvalidTransactionStateError(
        `${props.failureCode} is not a persistable rejection code`,
      );
    }
    this.currentStatus = WagerTransactionStatus.Rejected;
    this.currentFailureCode = props.failureCode;
    if (props.referenceTransactionId !== undefined) {
      this.currentReferenceTransactionId = props.referenceTransactionId;
    }
    this.currentBalanceSnapshot = props.balanceSnapshot;
    this.currentUpdatedAt = props.at;
  }

  fail(props: { balanceSnapshot: Money | undefined; at: Date }): void {
    if (this.currentStatus !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(
        `cannot move ${this.currentStatus} transaction to FAILED`,
      );
    }
    this.currentStatus = WagerTransactionStatus.Failed;
    this.currentFailureCode = FailureCode.ProcessingFailed;
    this.currentBalanceSnapshot = props.balanceSnapshot;
    this.currentUpdatedAt = props.at;
  }

  isTerminal(): boolean {
    return (
      this.currentStatus === WagerTransactionStatus.Processed ||
      this.currentStatus === WagerTransactionStatus.Rejected ||
      this.currentStatus === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  acceptsReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Win ||
      this.kind === WagerTransactionKind.Loss ||
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference: WagerTransaction | undefined): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        return oppositeDirection(WagerTransaction.walletDirectionOf(reference));
      case WagerTransactionKind.Loss:
        throw new InvalidLedgerPostingError('LOSS has no ledger posting');
    }
  }

  toState(): WagerTransactionState {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: this.money,
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      referenceTransactionId: this.currentReferenceTransactionId,
      status: this.currentStatus,
      failureCode: this.currentFailureCode,
      balanceSnapshot: this.currentBalanceSnapshot,
      correlationId: this.correlationId,
      createdAt: this.createdAt,
      processedAt: this.currentProcessedAt,
      updatedAt: this.currentUpdatedAt,
    };
  }

  private static walletDirectionOf(reference: WagerTransaction | undefined): LedgerDirection {
    if (reference === undefined) {
      throw new InvalidLedgerPostingError('ROLLBACK requires a reference transaction');
    }
    switch (reference.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      default:
        throw new InvalidLedgerPostingError(`ROLLBACK cannot reverse ${reference.kind}`);
    }
  }

  private assertOpen(target: string): void {
    if (
      this.currentStatus !== WagerTransactionStatus.Pending &&
      this.currentStatus !== WagerTransactionStatus.PendingReference
    ) {
      throw new InvalidTransactionStateError(
        `cannot move ${this.currentStatus} transaction to ${target}`,
      );
    }
  }
}
