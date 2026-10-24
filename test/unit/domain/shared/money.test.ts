import { describe, expect, it } from 'bun:test';
import { toCurrencyCode } from '@domain/shared/currency';
import { CurrencyMismatchError } from '@domain/shared/errors/currency-mismatch.error';
import { InvalidMoneyError } from '@domain/shared/errors/invalid-money.error';
import { PersistedMoneyCorruptedError } from '@domain/shared/errors/persisted-money-corrupted.error';
import { FailureCode } from '@domain/shared/failure-code';
import { Money } from '@domain/shared/money';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

describe('Money.from', () => {
  it('accepts a regular amount', () => {
    expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  it('accepts zero', () => {
    expect(brl('0.00').isZero()).toBe(true);
  });

  it('accepts 18 integer digits', () => {
    expect(brl('999999999999999999.99').toJSON().amount).toBe('999999999999999999.99');
  });

  it('rejects 19 integer digits', () => {
    expect(() => brl('1000000000000000000.00')).toThrow(InvalidMoneyError);
  });

  it.each([
    '25',
    '25.5',
    '25.500',
    '025.00',
    '+25.00',
    '-25.00',
    '2.5e1',
    'NaN',
    'Infinity',
    '',
    ' 25.00',
    '25.00\n',
    '٢٥.٠٠',
  ])('rejects the amount %p', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  it.each(['brl', 'BR', 'BRLL'])('rejects the currency %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  it('carries the invalid money failure code', () => {
    try {
      brl('25');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidMoneyError);
      expect(error instanceof InvalidMoneyError && error.failureCode).toBe(
        FailureCode.InvalidMoney,
      );
    }
  });
});

describe('Money arithmetic', () => {
  it('adds without drift', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
  });

  it('exceeds storage when the sum overflows numeric(20,2)', () => {
    expect(brl('999999999999999999.99').add(brl('0.01')).fitsStorage()).toBe(false);
  });

  it('keeps the largest storable value within storage', () => {
    expect(brl('999999999999999999.99').fitsStorage()).toBe(true);
  });

  it('does not fit storage when negative', () => {
    expect(brl('1.00').negate().fitsStorage()).toBe(false);
  });

  it('rejects adding different currencies', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('25.00').add(usd)).toThrow(CurrencyMismatchError);
  });

  it('rejects subtracting different currencies', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('25.00').subtract(usd)).toThrow(CurrencyMismatchError);
  });

  it('carries the currency mismatch failure code', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    try {
      brl('1.00').add(usd);
      expect.unreachable();
    } catch (error) {
      expect(error instanceof CurrencyMismatchError && error.failureCode).toBe(
        FailureCode.CurrencyMismatch,
      );
    }
  });

  it('subtracts into a negative result', () => {
    const result = brl('10.00').subtract(brl('25.00'));
    expect(result.toJSON().amount).toBe('-15.00');
    expect(result.isNegative()).toBe(true);
  });

  it('negates and restores the sign', () => {
    expect(brl('5.00').negate().negate().equals(brl('5.00'))).toBe(true);
  });

  it('sums 1000 parcels of 0.01 into 10.00', () => {
    let total = Money.zero('BRL');
    const parcel = brl('0.01');
    for (let index = 0; index < 1000; index += 1) {
      total = total.add(parcel);
    }
    expect(total.toJSON().amount).toBe('10.00');
  });

  it('sums 18 digit values exactly', () => {
    const total = brl('999999999999999999.99').add(brl('999999999999999999.99'));
    expect(total.toJSON().amount).toBe('1999999999999999999.98');
  });

  it('does not change the receiver', () => {
    const a = brl('1.00');
    const b = brl('2.00');
    a.add(b);
    a.subtract(b);
    a.negate();
    expect(a.toJSON().amount).toBe('1.00');
    expect(b.toJSON().amount).toBe('2.00');
  });
});

describe('Money comparisons', () => {
  it('detects positive, zero and negative values', () => {
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.00').isPositive()).toBe(false);
    expect(brl('0.00').isNegative()).toBe(false);
    expect(brl('0.01').negate().isNegative()).toBe(true);
  });

  it('compares values in the same currency', () => {
    expect(brl('1.00').isLessThan(brl('2.00'))).toBe(true);
    expect(brl('2.00').isLessThan(brl('2.00'))).toBe(false);
  });

  it('returns false from equals for different currencies', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(brl('1.00').equals(usd)).toBe(false);
  });

  it('throws from isLessThan for different currencies', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });
});

describe('Money serialization', () => {
  it('serializes positive, zero and negative values', () => {
    expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(brl('0.05').toJSON().amount).toBe('0.05');
    expect(brl('0.00').toJSON().amount).toBe('0.00');
    expect(brl('25.00').negate().toJSON().amount).toBe('-25.00');
    expect(brl('0.05').negate().toJSON().amount).toBe('-0.05');
  });

  it('formats toString with the currency', () => {
    expect(brl('25.00').toString()).toBe('25.00 BRL');
    expect(brl('0.00').toString()).toBe('0.00 BRL');
    expect(brl('25.00').negate().toString()).toBe('-25.00 BRL');
  });

  it('builds zero for a currency', () => {
    expect(Money.zero('USD').toString()).toBe('0.00 USD');
  });
});

describe('Money persistence factories', () => {
  it('reads a persisted value', () => {
    expect(Money.fromPersistence('25.50', 'BRL').toJSON().amount).toBe('25.50');
  });

  it('rejects a malformed persisted value without a failure code', () => {
    try {
      Money.fromPersistence('25.5', 'BRL');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PersistedMoneyCorruptedError);
      expect(error instanceof PersistedMoneyCorruptedError && error.failureCode).toBeUndefined();
    }
  });

  it('rejects a persisted negative value', () => {
    expect(() => Money.fromPersistence('-1.00', 'BRL')).toThrow(PersistedMoneyCorruptedError);
  });

  it('rejects a corrupted persisted currency', () => {
    expect(() => Money.fromPersistence('1.00', 'br')).toThrow(PersistedMoneyCorruptedError);
  });

  it('accepts a negative signed decimal', () => {
    const money = Money.fromSignedDecimal('-100000.00', 'BRL');
    expect(money.isNegative()).toBe(true);
    expect(money.toJSON().amount).toBe('-100000.00');
  });

  it('accepts a signed decimal with 30 integer digits', () => {
    const value = `${'9'.repeat(30)}.99`;
    expect(Money.fromSignedDecimal(value, 'BRL').toJSON().amount).toBe(value);
  });

  it('rejects negative zero', () => {
    expect(() => Money.fromSignedDecimal('-0.00', 'BRL')).toThrow(PersistedMoneyCorruptedError);
  });

  it('rejects a signed decimal with 31 integer digits', () => {
    expect(() => Money.fromSignedDecimal(`${'9'.repeat(31)}.00`, 'BRL')).toThrow(
      PersistedMoneyCorruptedError,
    );
  });
});

describe('toCurrencyCode', () => {
  it('accepts three uppercase letters', () => {
    expect(toCurrencyCode('EUR').toString()).toBe('EUR');
  });

  it('rejects anything else', () => {
    expect(() => toCurrencyCode('eur')).toThrow(InvalidMoneyError);
  });
});
