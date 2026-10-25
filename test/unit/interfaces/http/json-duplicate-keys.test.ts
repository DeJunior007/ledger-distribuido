import { describe, expect, it } from 'bun:test';
import { hasDuplicateJsonKey } from '@interfaces/http/json-duplicate-keys';

describe('hasDuplicateJsonKey', () => {
  const duplicated: readonly string[] = [
    '{"a":1,"a":2}',
    '{"a":1,"a":1}',
    '{"a":{"b":1,"b":2}}',
    '[{"a":1},{"b":1,"b":2}]',
    '{"a":[1,2],"a":3}',
    '{"a":[{"x":1}],"b":{"c":{"d":1,"d":1}}}',
    '{"\\u0061":1,"a":2}',
    '{"kind":"BET","\\u006bind":"BET"}',
    '{"\\/":1,"/":2}',
    '{ "a" : 1 , "a" : 2 }',
  ];

  const distinct: readonly string[] = [
    '{}',
    '[]',
    '{"a":1,"b":2}',
    '{"a":"a"}',
    '[{"a":1},{"a":2}]',
    '{"a":{"a":1}}',
    '{"a":[1,{"b":1}],"b":2}',
    '{"a":"x\\",\\"a\\":1","b":1}',
    '{"a\\\\":1,"a":2}',
    '{"a":"{","b":"}","c":"[,]"}',
    '{"a":[[],[{}],{"a":[]}],"b":null}',
    '"text"',
    '42',
  ];

  for (const text of duplicated) {
    it(`finds the repeated key in ${text}`, () => {
      expect(JSON.parse(text)).toBeDefined();
      expect(hasDuplicateJsonKey(text)).toBe(true);
    });
  }

  for (const text of distinct) {
    it(`finds no repeated key in ${text}`, () => {
      expect(JSON.parse(text)).toBeDefined();
      expect(hasDuplicateJsonKey(text)).toBe(false);
    });
  }
});
