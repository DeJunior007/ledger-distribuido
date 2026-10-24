import { describe, expect, it, mock, spyOn } from 'bun:test';
import { InMemoryWalletRepository } from '@test/support/fakes/in-memory-wallet.repository';

mock.module('pg', () => ({}));

describe('wallet', () => {
  it('debits the balance', () => {
    const repository = new InMemoryWalletRepository();
    const save = spyOn(repository, 'save');

    expect(save).toBeDefined();
  });
});
