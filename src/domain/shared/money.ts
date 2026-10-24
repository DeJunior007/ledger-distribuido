import { toCurrencyCode, type CurrencyCode } from './currency';
import { CurrencyMismatchError } from './errors/currency-mismatch.error';
import { InvalidMoneyError } from './errors/invalid-money.error';
import { PersistedMoneyCorruptedError } from './errors/persisted-money-corrupted.error';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const UNSIGNED_AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})\.\d{2}$/;
const SIGNED_AMOUNT_PATTERN = /^-?(0|[1-9]\d{0,29})\.\d{2}$/;
const MAX_STORAGE_CENTS = 99_999_999_999_999_999_999n;

function parseCents(text: string): bigint {
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole = '0', fraction = '0'] = unsigned.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction);
  return negative ? -cents : cents;
}

export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: CurrencyCode,
  ) {}

  static from(props: MoneyProps): Money {
    const currency = toCurrencyCode(props.currency);
    if (!UNSIGNED_AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError('amount must be a non-negative decimal with exactly 2 places');
    }
    return new Money(parseCents(props.amount), currency);
  }

  static fromPersistence(amount: string, currency: string): Money {
    if (!UNSIGNED_AMOUNT_PATTERN.test(amount)) {
      throw new PersistedMoneyCorruptedError('persisted amount has an invalid format');
    }
    return new Money(parseCents(amount), Money.persistedCurrency(currency));
  }

  static fromSignedDecimal(amount: string, currency: string): Money {
    if (!SIGNED_AMOUNT_PATTERN.test(amount) || amount.startsWith('-0.00')) {
      throw new PersistedMoneyCorruptedError('signed amount has an invalid format');
    }
    return new Money(parseCents(amount), Money.persistedCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(0n, toCurrencyCode(currency));
  }

  private static persistedCurrency(currency: string): CurrencyCode {
    try {
      return toCurrencyCode(currency);
    } catch {
      throw new PersistedMoneyCorruptedError('persisted currency has an invalid format');
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  fitsStorage(): boolean {
    return this.cents >= 0n && this.cents <= MAX_STORAGE_CENTS;
  }

  toJSON(): MoneyProps {
    const magnitude = this.cents < 0n ? -this.cents : this.cents;
    const whole = (magnitude / 100n).toString();
    const fraction = (magnitude % 100n).toString().padStart(2, '0');
    const sign = this.cents < 0n ? '-' : '';
    return { amount: `${sign}${whole}.${fraction}`, currency: this.currency };
  }

  toString(): string {
    const { amount, currency } = this.toJSON();
    return `${amount} ${currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError('operation requires money in the same currency');
    }
  }
}
