import { InvalidMoneyError } from './errors/invalid-money.error';

export type CurrencyCode = string & { readonly brand: 'CurrencyCode' };

export const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

function isCurrencyCode(value: string): value is CurrencyCode {
  return CURRENCY_CODE_PATTERN.test(value);
}

export function toCurrencyCode(value: string): CurrencyCode {
  if (!isCurrencyCode(value)) {
    throw new InvalidMoneyError('currency must be three uppercase ASCII letters');
  }
  return value;
}
