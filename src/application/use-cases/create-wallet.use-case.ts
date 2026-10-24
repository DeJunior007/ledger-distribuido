import type { CreateWalletCommand } from '@application/commands/create-wallet.command';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import { WalletAlreadyExistsError } from '@application/errors/wallet-already-exists.error';
import type { ClockPort } from '@application/ports/clock.port';
import type { ContextEnricher } from '@application/ports/context-enricher';
import type { HasherPort } from '@application/ports/hasher.port';
import type { IdGeneratorPort } from '@application/ports/id-generator.port';
import type { LoggerPort } from '@application/ports/logger.port';
import type { MetricsPort } from '@application/ports/metrics.port';
import type { TracerPort } from '@application/ports/tracer.port';
import type { Repositories, UnitOfWorkPort } from '@application/ports/unit-of-work.port';
import { computeOpeningPayloadHash } from '@application/services/payload-hash';
import type { WalletView } from '@application/views/wallet.view';
import { WagerTransactionProcessed } from '@domain/messaging/events/wager-transaction-processed.event';
import { WalletBalanceChanged } from '@domain/messaging/events/wallet-balance-changed.event';
import type { EventContext } from '@domain/messaging/integration-event';
import { OutboxMessage } from '@domain/messaging/outbox-message';
import { Money } from '@domain/shared/money';
import { WagerTransaction } from '@domain/wagering/wager-transaction';
import { HouseAccountPurpose } from '@domain/wallet/house-account';
import type { LedgerPosting } from '@domain/wallet/ledger-posting';
import { Wallet } from '@domain/wallet/wallet';

const WALLET_PLAYER_CURRENCY_CONSTRAINT = 'wallets_player_currency_uq';

export interface CreateWalletDependencies {
  uow: UnitOfWorkPort;
  clock: ClockPort;
  ids: IdGeneratorPort;
  hasher: HasherPort;
  logger: LoggerPort;
  metrics: MetricsPort;
  tracer: TracerPort;
  enrich: ContextEnricher;
}

const toWalletView = (wallet: Wallet): WalletView => ({
  id: wallet.id,
  playerId: wallet.playerId,
  balance: wallet.balance.toJSON(),
  version: wallet.version,
  createdAt: wallet.createdAt.toISOString(),
  updatedAt: wallet.updatedAt.toISOString(),
});

const isPlayerCurrencyRace = (error: unknown): error is TechnicalError =>
  error instanceof TechnicalError &&
  error.errorClass === ErrorClass.Race &&
  error.constraint === WALLET_PLAYER_CURRENCY_CONSTRAINT;

export class CreateWalletUseCase {
  constructor(private readonly deps: CreateWalletDependencies) {}

  execute(command: CreateWalletCommand): Promise<WalletView> {
    return this.deps.tracer.inSpan('usecase.create-wallet', {}, () => this.create(command));
  }

  private async create(command: CreateWalletCommand): Promise<WalletView> {
    const initialBalance = Money.from(command.initialBalance);
    try {
      const view = await this.deps.uow.run('write', (repos) =>
        this.openWallet(repos, command, initialBalance),
      );
      this.deps.enrich({ walletId: view.id });
      this.deps.logger.info('wallet created', {
        walletId: view.id,
        correlationId: command.correlationId,
      });
      return view;
    } catch (error) {
      if (!isPlayerCurrencyRace(error)) {
        throw error;
      }
      throw await this.alreadyExists(command.playerId, initialBalance.currency, error);
    }
  }

  private async openWallet(
    repos: Repositories,
    command: CreateWalletCommand,
    initialBalance: Money,
  ): Promise<WalletView> {
    const { clock, ids } = this.deps;
    const now = clock.now();
    const currency = initialBalance.currency;
    await repos.houseAccounts.ensure(currency, HouseAccountPurpose.Gaming, ids.next(), now);
    const funding = await repos.houseAccounts.ensure(
      currency,
      HouseAccountPurpose.Funding,
      ids.next(),
      now,
    );
    const { wallet, posting } = Wallet.open({
      id: ids.next(),
      playerId: command.playerId,
      initialBalance,
      openingTransactionId: ids.next(),
      fundingAccountId: funding.id,
      walletEntryId: ids.next(),
      houseEntryId: ids.next(),
      now,
    });
    repos.wallets.insert(wallet);
    if (posting !== undefined) {
      this.recordOpening(repos, command, wallet, posting, now);
    }
    return toWalletView(wallet);
  }

  private recordOpening(
    repos: Repositories,
    command: CreateWalletCommand,
    wallet: Wallet,
    posting: LedgerPosting,
    now: Date,
  ): void {
    const money = posting.walletEntry.money;
    const opening = WagerTransaction.opening({
      id: posting.walletEntry.transactionId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      money,
      payloadHash: computeOpeningPayloadHash(
        { walletId: wallet.id, money: money.toJSON() },
        this.deps.hasher,
      ),
      correlationId: command.correlationId,
      now,
    });
    repos.transactions.insert(opening);
    repos.ledger.insertPosting(posting);
    repos.outbox.enqueue(
      OutboxMessage.enqueue(
        WagerTransactionProcessed.from(opening, wallet, this.eventContext(command, now)),
      ),
    );
    repos.outbox.enqueue(
      OutboxMessage.enqueue(
        WalletBalanceChanged.from(wallet, posting.walletEntry, this.eventContext(command, now)),
      ),
    );
  }

  private eventContext(command: CreateWalletCommand, now: Date): EventContext {
    return {
      eventId: this.deps.ids.next(),
      correlationId: command.correlationId,
      causationId: command.causationId,
      occurredAt: now,
    };
  }

  private async alreadyExists(
    playerId: string,
    currency: string,
    race: TechnicalError,
  ): Promise<Error> {
    const existing = await this.deps.uow.read((repos) =>
      repos.wallets.findByPlayerAndCurrency(playerId, currency),
    );
    if (existing === undefined) {
      return race;
    }
    this.deps.enrich({ walletId: existing.id });
    return new WalletAlreadyExistsError(existing.id);
  }
}
