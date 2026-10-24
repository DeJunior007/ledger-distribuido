import { FailureCode } from '../shared/failure-code';
import { WagerTransaction } from './wager-transaction';
import { WagerTransactionKind } from './wager-transaction-kind';
import { WagerTransactionStatus } from './wager-transaction-status';

export type ReferenceDecision =
  | { type: 'WAIT' }
  | { type: 'REJECT'; failureCode: FailureCode; referenceTransactionId: string | undefined }
  | { type: 'APPLY'; referenceTransactionId: string | undefined };

export interface DecideReferenceInput {
  transaction: WagerTransaction;
  reference: WagerTransaction | undefined;
  referenceAlreadyReversed: boolean;
}

const REVERSAL_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

const ROLLBACK_REFERENCE_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
];

function reject(failureCode: FailureCode, reference: WagerTransaction): ReferenceDecision {
  return { type: 'REJECT', failureCode, referenceTransactionId: reference.id };
}

function hasMismatchedIdentity(
  transaction: WagerTransaction,
  reference: WagerTransaction,
): boolean {
  return (
    transaction.providerId !== reference.providerId ||
    transaction.playerId !== reference.playerId ||
    transaction.walletId !== reference.walletId ||
    transaction.money.currency !== reference.money.currency ||
    transaction.roundId !== reference.roundId
  );
}

function hasInvalidReferenceKind(
  transaction: WagerTransaction,
  reference: WagerTransaction,
): boolean {
  switch (transaction.kind) {
    case WagerTransactionKind.Refund:
      return reference.kind !== WagerTransactionKind.Bet;
    case WagerTransactionKind.Rollback:
      return !ROLLBACK_REFERENCE_KINDS.includes(reference.kind);
    case WagerTransactionKind.Win:
    case WagerTransactionKind.Loss:
      return reference.kind !== WagerTransactionKind.Bet;
    default:
      return false;
  }
}

export function decideReference(input: DecideReferenceInput): ReferenceDecision {
  const { transaction, reference, referenceAlreadyReversed } = input;
  if (transaction.referenceExternalTransactionId === undefined) {
    return { type: 'APPLY', referenceTransactionId: undefined };
  }
  if (reference === undefined) {
    return { type: 'WAIT' };
  }
  if (reference.status === WagerTransactionStatus.PendingReference) {
    return { type: 'WAIT' };
  }
  if (
    reference.status === WagerTransactionStatus.Rejected ||
    reference.status === WagerTransactionStatus.Failed
  ) {
    return reject(FailureCode.ReferenceNotProcessed, reference);
  }
  if (hasMismatchedIdentity(transaction, reference)) {
    return reject(FailureCode.ReferenceMismatch, reference);
  }
  if (hasInvalidReferenceKind(transaction, reference)) {
    return reject(FailureCode.InvalidReferenceKind, reference);
  }
  const isReversal = REVERSAL_KINDS.includes(transaction.kind);
  if (isReversal && !transaction.money.equals(reference.money)) {
    return reject(FailureCode.AmountMismatch, reference);
  }
  if (referenceAlreadyReversed && (isReversal || transaction.kind === WagerTransactionKind.Win)) {
    return reject(FailureCode.ReferenceAlreadyReversed, reference);
  }
  return { type: 'APPLY', referenceTransactionId: reference.id };
}
