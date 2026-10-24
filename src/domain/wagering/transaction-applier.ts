import { FailureCode } from '../shared/failure-code';
import { BalanceLimitExceededError } from '../wallet/errors/balance-limit-exceeded.error';
import { InsufficientFundsError } from '../wallet/errors/insufficient-funds.error';
import { LedgerDirection } from '../wallet/ledger-direction';
import type { LedgerPosting } from '../wallet/ledger-posting';
import type { Wallet, WalletMovementProps } from '../wallet/wallet';
import type { ReferenceDecision } from './reference-policy';
import type { WagerTransaction } from './wager-transaction';
import { WagerTransactionKind } from './wager-transaction-kind';

export type ApplyResult =
  | { outcome: 'PROCESSED'; posting: LedgerPosting | undefined }
  | { outcome: 'REJECTED'; failureCode: FailureCode }
  | { outcome: 'PENDING_REFERENCE' };

export interface CheckContextInput {
  wallet: Wallet;
  transaction: WagerTransaction;
  now: Date;
}

export interface ApplyInput {
  wallet: Wallet;
  transaction: WagerTransaction;
  reference: WagerTransaction | undefined;
  decision: ReferenceDecision;
  gamingAccountId: string;
  walletEntryId: string;
  houseEntryId: string;
  now: Date;
}

interface RejectionProps {
  wallet: Wallet;
  transaction: WagerTransaction;
  failureCode: FailureCode;
  referenceTransactionId: string | undefined;
  now: Date;
}

function rejectTransaction(props: RejectionProps): ApplyResult {
  props.transaction.reject({
    failureCode: props.failureCode,
    referenceTransactionId: props.referenceTransactionId,
    balanceSnapshot: props.wallet.balance,
    at: props.now,
  });
  return { outcome: 'REJECTED', failureCode: props.failureCode };
}

function processTransaction(
  input: ApplyInput,
  referenceTransactionId: string | undefined,
  posting: LedgerPosting | undefined,
): ApplyResult {
  input.transaction.markProcessed({
    referenceTransactionId,
    balanceSnapshot: input.wallet.balance,
    at: input.now,
  });
  return { outcome: 'PROCESSED', posting };
}

function movementOf(input: ApplyInput): WalletMovementProps {
  return {
    transactionId: input.transaction.id,
    money: input.transaction.money,
    houseAccountId: input.gamingAccountId,
    walletEntryId: input.walletEntryId,
    houseEntryId: input.houseEntryId,
    now: input.now,
  };
}

function insufficientFundsCodeFor(transaction: WagerTransaction): FailureCode {
  return transaction.kind === WagerTransactionKind.Rollback
    ? FailureCode.InsufficientFundsForReversal
    : FailureCode.InsufficientFunds;
}

function applyDebit(input: ApplyInput, referenceTransactionId: string | undefined): ApplyResult {
  let posting: LedgerPosting;
  try {
    posting = input.wallet.debit(movementOf(input));
  } catch (error) {
    if (error instanceof InsufficientFundsError) {
      return rejectTransaction({
        wallet: input.wallet,
        transaction: input.transaction,
        failureCode: insufficientFundsCodeFor(input.transaction),
        referenceTransactionId,
        now: input.now,
      });
    }
    throw error;
  }
  return processTransaction(input, referenceTransactionId, posting);
}

function applyCredit(input: ApplyInput, referenceTransactionId: string | undefined): ApplyResult {
  let posting: LedgerPosting;
  try {
    posting = input.wallet.credit(movementOf(input));
  } catch (error) {
    if (error instanceof BalanceLimitExceededError) {
      return rejectTransaction({
        wallet: input.wallet,
        transaction: input.transaction,
        failureCode: FailureCode.BalanceLimitExceeded,
        referenceTransactionId,
        now: input.now,
      });
    }
    throw error;
  }
  return processTransaction(input, referenceTransactionId, posting);
}

export class TransactionApplier {
  private constructor() {
    Object.freeze(this);
  }

  static create(): TransactionApplier {
    return new TransactionApplier();
  }

  checkContext(input: CheckContextInput): ApplyResult | undefined {
    const { wallet, transaction, now } = input;
    if (transaction.playerId !== wallet.playerId) {
      return rejectTransaction({
        wallet,
        transaction,
        failureCode: FailureCode.PlayerWalletMismatch,
        referenceTransactionId: undefined,
        now,
      });
    }
    if (transaction.money.currency !== wallet.currency) {
      return rejectTransaction({
        wallet,
        transaction,
        failureCode: FailureCode.CurrencyMismatch,
        referenceTransactionId: undefined,
        now,
      });
    }
    return undefined;
  }

  apply(input: ApplyInput): ApplyResult {
    const { decision } = input;
    switch (decision.type) {
      case 'WAIT':
        input.transaction.markPendingReference({
          balanceSnapshot: input.wallet.balance,
          at: input.now,
        });
        return { outcome: 'PENDING_REFERENCE' };
      case 'REJECT':
        return rejectTransaction({
          wallet: input.wallet,
          transaction: input.transaction,
          failureCode: decision.failureCode,
          referenceTransactionId: decision.referenceTransactionId,
          now: input.now,
        });
      case 'APPLY':
        return this.applyMovement(input, decision.referenceTransactionId);
    }
  }

  private applyMovement(
    input: ApplyInput,
    referenceTransactionId: string | undefined,
  ): ApplyResult {
    if (input.transaction.kind === WagerTransactionKind.Loss) {
      return processTransaction(input, referenceTransactionId, undefined);
    }
    const direction = input.transaction.ledgerDirectionFor(input.reference);
    return direction === LedgerDirection.Debit
      ? applyDebit(input, referenceTransactionId)
      : applyCredit(input, referenceTransactionId);
  }
}
