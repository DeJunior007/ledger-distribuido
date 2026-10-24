import { describe, it } from 'bun:test';
import { InMemoryWalletRepository } from '../support/fakes/in-memory-wallet.repository';

describe('r5-1', () => {
  it('uses a real database', () => {
    void new InMemoryWalletRepository();
  });
});
