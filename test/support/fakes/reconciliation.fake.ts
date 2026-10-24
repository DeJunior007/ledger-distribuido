import {
  ReconciliationRepositoryPort,
  type CurrencySums,
  type ReconciliationRunInput,
  type WalletBatchRow,
  type WalletSnapshot,
} from '@application/ports/repositories/reconciliation-repository.port';
import { Money } from '@domain/shared/money';
import { HouseAccountPurpose } from '@domain/wallet/house-account';
import { LedgerDirection } from '@domain/wallet/ledger-direction';
import type { WalletLedgerEntryState } from '@domain/wallet/wallet-ledger-entry';
import { settle } from './in-memory-unit-of-work.fake';
import type { FakeTransaction } from './in-memory-unit-of-work.fake';

interface SignedEntry {
  readonly direction: LedgerDirection;
  readonly money: Money;
}

const signed = (entry: SignedEntry): Money =>
  entry.direction === LedgerDirection.Credit ? entry.money : entry.money.negate();

const sumOf = (currency: string, entries: readonly Money[]): Money =>
  entries.reduce((total, amount) => total.add(amount), Money.zero(currency));

const amountOf = (money: Money): string => money.toJSON().amount;

const byVersion = (left: WalletLedgerEntryState, right: WalletLedgerEntryState): number =>
  left.walletVersion - right.walletVersion;

export class InMemoryReconciliationRepository extends ReconciliationRepositoryPort {
  constructor(private readonly transaction: FakeTransaction) {
    super();
  }

  walletSnapshot(walletId: string): Promise<WalletSnapshot | undefined> {
    return settle(() => {
      const wallet = this.transaction.wallets.find(walletId);
      if (wallet === undefined) {
        return undefined;
      }
      const entries = this.transaction.walletEntries
        .rows()
        .filter((entry) => entry.walletId === walletId)
        .sort(byVersion);
      const ofDirection = (direction: LedgerDirection): string =>
        amountOf(
          sumOf(
            wallet.currency,
            entries.filter((entry) => entry.direction === direction).map((entry) => entry.money),
          ),
        );
      return {
        walletId: wallet.id,
        currency: wallet.currency,
        balance: amountOf(wallet.balance),
        version: wallet.version,
        credits: ofDirection(LedgerDirection.Credit),
        debits: ofDirection(LedgerDirection.Debit),
        entries: entries.length,
        chain: entries.map((entry) => ({
          walletVersion: entry.walletVersion,
          direction: entry.direction,
          amount: amountOf(entry.money),
          currency: entry.money.currency,
          balanceBefore: amountOf(entry.balanceBefore),
          balanceAfter: amountOf(entry.balanceAfter),
        })),
      };
    });
  }

  globalSums(): Promise<CurrencySums[]> {
    return settle(() => {
      const wallets = this.transaction.wallets.rows();
      const houseAccounts = this.transaction.houseAccounts.rows();
      const walletEntries = this.transaction.walletEntries.rows();
      const houseEntries = this.transaction.houseEntries.rows();
      const currencies = [
        ...new Set([
          ...wallets.map((wallet) => wallet.currency),
          ...houseAccounts.map((account) => account.currency),
        ]),
      ].sort();
      return currencies.map((currency) => {
        const houseBalance = (purpose: HouseAccountPurpose): Money => {
          const accountIds = new Set(
            houseAccounts
              .filter((account) => account.currency === currency && account.purpose === purpose)
              .map((account) => account.id),
          );
          return sumOf(
            currency,
            houseEntries.filter((entry) => accountIds.has(entry.houseAccountId)).map(signed),
          );
        };
        const everyEntry: SignedEntry[] = [...walletEntries, ...houseEntries];
        return {
          currency,
          walletsTotal: amountOf(
            sumOf(
              currency,
              wallets.filter((wallet) => wallet.currency === currency).map((w) => w.balance),
            ),
          ),
          fundingBalance: amountOf(houseBalance(HouseAccountPurpose.Funding)),
          gamingBalance: amountOf(houseBalance(HouseAccountPurpose.Gaming)),
          ledgerNet: amountOf(
            sumOf(
              currency,
              everyEntry.filter((entry) => entry.money.currency === currency).map(signed),
            ),
          ),
        };
      });
    });
  }

  walletBatch(afterId: string | undefined, limit: number): Promise<WalletBatchRow[]> {
    return settle(() => {
      const entries = this.transaction.walletEntries.rows();
      return this.transaction.wallets
        .rows()
        .filter((wallet) => afterId === undefined || wallet.id > afterId)
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
        .slice(0, limit)
        .map((wallet) => {
          const own = entries.filter((entry) => entry.walletId === wallet.id);
          const versions = own.map((entry) => entry.walletVersion);
          return {
            walletId: wallet.id,
            balance: amountOf(wallet.balance),
            version: wallet.version,
            calculated: amountOf(sumOf(wallet.currency, own.map(signed))),
            entries: own.length,
            firstVersion: own.length === 0 ? undefined : Math.min(...versions),
            lastVersion: own.length === 0 ? undefined : Math.max(...versions),
          };
        });
    });
  }

  insertRun(run: ReconciliationRunInput): void {
    this.transaction.reconciliationRuns.insert(run);
  }
}
