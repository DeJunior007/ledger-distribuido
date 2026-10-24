import { describe, expect, it } from 'bun:test';
import { Sha256Hasher } from '@infrastructure/system/sha256-hasher';

describe('Sha256Hasher', () => {
  it('hashes abc to the known lowercase hex digest', () => {
    expect(new Sha256Hasher().sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
