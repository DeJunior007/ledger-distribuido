import { describe, expect, it } from 'bun:test';
import { canonicalJson } from '@application/services/canonical-json';
import { CanonicalJsonError } from '@application/services/errors/canonical-json.error';

const serializeUnchecked = (value: unknown): void => {
  Reflect.apply(canonicalJson, undefined, [value]);
};

describe('canonicalJson', () => {
  it('sorts keys by UTF-16 code unit at every nesting level', () => {
    expect(
      canonicalJson({
        b: 'y',
        a: { z: 'last', B: 'upper', m: [{ d: 'x', c: 'w' }] },
        _: 'underscore',
      }),
    ).toBe('{"_":"underscore","a":{"B":"upper","m":[{"c":"w","d":"x"}],"z":"last"},"b":"y"}');
  });

  it('keeps array elements in their original order', () => {
    expect(canonicalJson(['b', 'a', true, false, []])).toBe('["b","a",true,false,[]]');
  });

  it('omits keys whose value is undefined', () => {
    expect(canonicalJson({ a: 'x', b: undefined, c: { d: undefined } })).toBe('{"a":"x","c":{}}');
  });

  it('escapes strings and keys the same way JSON.stringify does', () => {
    expect(
      canonicalJson({ 'k"ey': 'quote " backslash \\ newline \n tab \t unicode é \u0001' }),
    ).toBe('{"k\\"ey":"quote \\" backslash \\\\ newline \\n tab \\t unicode é \\u0001"}');
  });

  it('serializes booleans without spaces', () => {
    expect(canonicalJson({ yes: true, no: false })).toBe('{"no":false,"yes":true}');
  });

  it.each([
    ['null', null],
    ['a number', 1],
    ['a bigint', 1n],
    ['a Date', new Date(0)],
    ['a function', () => 'x'],
    ['a nested null', { a: { b: null } }],
    ['a number inside an array', ['a', 2]],
    ['undefined inside an array', ['a', undefined]],
    ['a Map', new Map()],
  ])('throws CanonicalJsonError for %s', (_label, value) => {
    expect(() => {
      serializeUnchecked(value);
    }).toThrow(CanonicalJsonError);
  });
});
