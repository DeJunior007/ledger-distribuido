import type { CurrencyCode } from '../shared/currency';
import { CurrencyMismatchError } from '../shared/errors/currency-mismatch.error';
import { Money } from '../shared/money';
import { BalanceLimitExceededError } from './errors/balance-limit-exceeded.error';
import { InsufficientFundsError } from './errors/insufficient-funds.error';
import { InvalidAmountError } from './errors/invalid-amount.error';
import { HouseLedgerEntry } from './house-ledger-entry';
import { LedgerDirection, oppositeDirection } from './ledger-direction';
import { LedgerPosting } from './ledger-posting';
import { WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: CurrencyCode;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  openingTransactionId: string;
  fundingAccountId: string;
  walletEntryId: string;
  houseEntryId: string;
  now: Date;
}

export interface WalletMovementProps {
  transactionId: string;
  money: Money;
  houseAccountId: string;
  walletEntryId: string;
  houseEntryId: string;
  now: Date;
}

interface PostingDraft {
  walletId: string;
  transactionId: string;
  walletDirection: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number;
  houseAccountId: string;
  walletEntryId: string;
  houseEntryId: string;
  now: Date;
}

function buildPosting(draft: PostingDraft): LedgerPosting {
  const walletEntry = WalletLedgerEntry.create({
    id: draft.walletEntryId,
    walletId: draft.walletId,
    transactionId: draft.transactionId,
    direction: draft.walletDirection,
    money: draft.money,
    balanceBefore: draft.balanceBefore,
    balanceAfter: draft.balanceAfter,
    walletVersion: draft.walletVersion,
    createdAt: draft.now,
  });
  const houseEntry = HouseLedgerEntry.create({
    id: draft.houseEntryId,
    houseAccountId: draft.houseAccountId,
    transactionId: draft.transactionId,
    direction: oppositeDirection(draft.walletDirection),
    money: draft.money,
    createdAt: draft.now,
  });
  return LedgerPosting.create({ walletEntry, houseEntry });
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: CurrencyCode,
    public readonly createdAt: Date,
    private currentBalance: Money,
    private currentVersion: number,
    private lastUpdatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): { wallet: Wallet; posting: LedgerPosting | undefined } {
    const { initialBalance } = props;
    if (initialBalance.isNegative()) {
      throw new InvalidAmountError('initial balance must not be negative');
    }
    const wallet = new Wallet(
      props.id,
      props.playerId,
      initialBalance.currency,
      props.now,
      initialBalance,
      1,
      props.now,
    );
    if (initialBalance.isZero()) {
      return { wallet, posting: undefined };
    }
    const posting = buildPosting({
      walletId: props.id,
      transactionId: props.openingTransactionId,
      walletDirection: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      walletVersion: 1,
      houseAccountId: props.fundingAccountId,
      walletEntryId: props.walletEntryId,
      houseEntryId: props.houseEntryId,
      now: props.now,
    });
    return { wallet, posting };
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.createdAt,
      state.balance,
      state.version,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this.currentBalance;
  }

  get version(): number {
    return this.currentVersion;
  }

  get updatedAt(): Date {
    return this.lastUpdatedAt;
  }

  debit(props: WalletMovementProps): LedgerPosting {
    this.assertMovable(props.money);
    if (this.currentBalance.isLessThan(props.money)) {
      throw new InsufficientFundsError('wallet balance is insufficient for this debit');
    }
    return this.apply(LedgerDirection.Debit, this.currentBalance.subtract(props.money), props);
  }

  credit(props: WalletMovementProps): LedgerPosting {
    this.assertMovable(props.money);
    const balanceAfter = this.currentBalance.add(props.money);
    if (!balanceAfter.fitsStorage()) {
      throw new BalanceLimitExceededError('wallet balance would exceed the storage limit');
    }
    return this.apply(LedgerDirection.Credit, balanceAfter, props);
  }

  toState(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this.currentBalance,
      version: this.currentVersion,
      createdAt: this.createdAt,
      updatedAt: this.lastUpdatedAt,
    };
  }

  private assertMovable(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidAmountError('movement amount must be positive');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError('movement currency differs from wallet currency');
    }
  }

  private apply(
    walletDirection: LedgerDirection,
    balanceAfter: Money,
    props: WalletMovementProps,
  ): LedgerPosting {
    const walletVersion = this.currentVersion + 1;
    const posting = buildPosting({
      walletId: this.id,
      transactionId: props.transactionId,
      walletDirection,
      money: props.money,
      balanceBefore: this.currentBalance,
      balanceAfter,
      walletVersion,
      houseAccountId: props.houseAccountId,
      walletEntryId: props.walletEntryId,
      houseEntryId: props.houseEntryId,
      now: props.now,
    });
    this.currentBalance = balanceAfter;
    this.currentVersion = walletVersion;
    this.lastUpdatedAt = props.now;
    return posting;
  }
}
