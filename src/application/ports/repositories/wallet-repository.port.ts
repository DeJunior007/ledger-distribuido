import type { Wallet } from '@domain/wallet/wallet';

export interface LockedWallet {
  wallet: Wallet;
  contended: boolean;
  waitSeconds: number;
}

export abstract class WalletRepositoryPort {
  abstract lockById(id: string): Promise<LockedWallet | undefined>;
  abstract findById(id: string): Promise<Wallet | undefined>;
  abstract findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;
  abstract insert(wallet: Wallet): void;
  abstract update(wallet: Wallet): void;
  abstract assertPersistedVersion(wallet: Wallet): Promise<void>;
}
