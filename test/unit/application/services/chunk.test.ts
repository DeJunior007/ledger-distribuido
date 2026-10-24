import { describe, expect, it } from 'bun:test';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import { chunk } from '@application/services/chunk';

const range = (length: number): number[] => Array.from({ length }, (_, index) => index);

describe('chunk', () => {
  it('returns no chunks for an empty list', () => {
    expect(chunk([], 10)).toEqual([]);
  });

  it('keeps a list smaller than the size in a single chunk', () => {
    expect(chunk(range(3), 10)).toEqual([[0, 1, 2]]);
  });

  it('splits an exact multiple into full chunks', () => {
    expect(chunk(range(20), 10)).toEqual([range(10), range(20).slice(10)]);
  });

  it('puts the remainder in a last shorter chunk preserving order', () => {
    const chunks = chunk(range(23), 10);
    expect(chunks.map((part) => part.length)).toEqual([10, 10, 3]);
    expect(chunks.flat()).toEqual(range(23));
  });

  it('does not mutate the input list', () => {
    const items = range(5);
    chunk(items, 2);
    expect(items).toEqual(range(5));
  });

  it.each([0, -1, 2.5, Number.NaN])('rejects the invalid size %p as deterministic', (size) => {
    let caught: unknown;
    try {
      chunk(range(3), size);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TechnicalError);
    expect(caught).toMatchObject({ errorClass: ErrorClass.Deterministic });
  });
});
