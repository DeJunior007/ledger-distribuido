import type { CurrencyCode } from '../shared/currency';
import { WagerTransactionKind } from '../wagering/wager-transaction-kind';
import { InvalidLedgerPostingError } from './errors/invalid-ledger-posting.error';

export enum HouseAccountPurpose {
  Gaming = 'GAMING',
  Funding = 'FUNDING',
}

export interface HouseAccountState {
  id: string;
  currency: CurrencyCode;
  purpose: HouseAccountPurpose;
  createdAt: Date;
}

export class HouseAccount {
  private constructor(
    public readonly id: string,
    public readonly currency: CurrencyCode,
    public readonly purpose: HouseAccountPurpose,
    public readonly createdAt: Date,
  ) {}

  static create(props: HouseAccountState): HouseAccount {
    return new HouseAccount(props.id, props.currency, props.purpose, props.createdAt);
  }

  static rehydrate(state: HouseAccountState): HouseAccount {
    return new HouseAccount(state.id, state.currency, state.purpose, state.createdAt);
  }
}

export function houseAccountPurposeFor(kind: WagerTransactionKind): HouseAccountPurpose {
  switch (kind) {
    case WagerTransactionKind.Opening:
      return HouseAccountPurpose.Funding;
    case WagerTransactionKind.Bet:
    case WagerTransactionKind.Win:
    case WagerTransactionKind.Refund:
    case WagerTransactionKind.Rollback:
      return HouseAccountPurpose.Gaming;
    case WagerTransactionKind.Loss:
      throw new InvalidLedgerPostingError('a loss transaction has no ledger entry');
  }
}
