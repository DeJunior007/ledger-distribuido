import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import type { MoneyProps } from '@domain/shared/money';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { CreateWalletUseCase } from '@application/use-cases/create-wallet.use-case';
import type { AppConfig } from '@infrastructure/config/env.schema';
import { contextEnricher } from '@infrastructure/observability/context-enricher';
import { createMetricsRegistry } from '@infrastructure/observability/metrics.registry';
import { PinoLoggerAdapter } from '@infrastructure/observability/pino-logger.adapter';
import { PromMetricsAdapter } from '@infrastructure/observability/prom-metrics.adapter';
import { MikroOrmUnitOfWork } from '@infrastructure/persistence/mikro-orm-unit-of-work';
import type { OrmInstances } from '@infrastructure/persistence/orm-instances';
import { NoopTracer } from '@infrastructure/system/noop-tracer';
import { Sha256Hasher } from '@infrastructure/system/sha256-hasher';
import { SystemClock } from '@infrastructure/system/system-clock';
import { Uuidv7IdGenerator } from '@infrastructure/system/uuidv7-id-generator';
import type {
  RequestWagerKind,
  WagerTransactionData,
  WagerTransactionRequest,
} from '@interfaces/http/schemas/wager-transaction.schema';
import { TEST_PROVIDER_ID } from './test-issuer';

export const FIXTURE_CURRENCY = 'BRL';
export const FIXTURE_INITIAL_BALANCE: MoneyProps = { amount: '1000.00', currency: 'BRL' };
export const FIXTURE_AMOUNT = '10.00';
export const FIXTURE_GAME_ID = 'fixture-game';

export interface WalletRequest {
  readonly playerId: string;
  readonly initialBalance: MoneyProps;
}

export interface TestWallet {
  readonly id: string;
  readonly playerId: string;
  readonly balance: MoneyProps;
  readonly version: number;
}

export interface WalletUseCaseResources {
  readonly orm: OrmInstances;
  readonly config: AppConfig;
}

export interface WagerCommandOptions {
  readonly wallet: Pick<TestWallet, 'id' | 'playerId'>;
  readonly amount?: string;
  readonly currency?: string;
  readonly providerId?: string;
  readonly externalTransactionId?: string;
  readonly idempotencyKey?: string;
  readonly roundId?: string;
  readonly gameId?: string;
  readonly referenceExternalTransactionId?: string;
}

export interface ReversalCommandOptions extends WagerCommandOptions {
  readonly referenceExternalTransactionId: string;
}

export class FixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixtureError';
  }
}

export const walletRequest = (overrides: Partial<WalletRequest> = {}): WalletRequest => ({
  playerId: overrides.playerId ?? randomUUID(),
  initialBalance: overrides.initialBalance ?? FIXTURE_INITIAL_BALANCE,
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isMoney = (value: unknown): value is MoneyProps =>
  isRecord(value) && typeof value.amount === 'string' && typeof value.currency === 'string';

const toTestWallet = (value: unknown): TestWallet => {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.playerId !== 'string' ||
    typeof value.version !== 'number' ||
    !isMoney(value.balance)
  ) {
    throw new FixtureError(`unexpected wallet body: ${JSON.stringify(value)}`);
  }
  return {
    id: value.id,
    playerId: value.playerId,
    balance: value.balance,
    version: value.version,
  };
};

export const createWalletViaApi = async (
  baseUrl: string,
  operatorToken: string,
  overrides: Partial<WalletRequest> = {},
): Promise<TestWallet> => {
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${operatorToken}` },
    body: JSON.stringify(walletRequest(overrides)),
  });
  if (response.status !== 201) {
    throw new FixtureError(
      `POST /wallets answered ${String(response.status)}: ${await response.text()}`,
    );
  }
  return toTestWallet(await response.json());
};

const silentLogger = (): PinoLoggerAdapter => new PinoLoggerAdapter(pino({ level: 'silent' }));

export const createWalletViaUseCase = async (
  resources: WalletUseCaseResources,
  overrides: Partial<WalletRequest> = {},
): Promise<TestWallet> => {
  const useCase = new CreateWalletUseCase({
    uow: new MikroOrmUnitOfWork(resources.orm, resources.config),
    clock: new SystemClock(),
    ids: new Uuidv7IdGenerator(),
    hasher: new Sha256Hasher(),
    logger: silentLogger(),
    metrics: new PromMetricsAdapter(createMetricsRegistry().metrics),
    tracer: new NoopTracer(),
    enrich: contextEnricher,
  });
  const request = walletRequest(overrides);
  const correlationId = randomUUID();
  const view = await useCase.execute({
    playerId: request.playerId,
    initialBalance: request.initialBalance,
    correlationId,
    causationId: correlationId,
  });
  return toTestWallet(view);
};

export const wagerCommand = (
  kind: RequestWagerKind,
  options: WagerCommandOptions,
): WagerTransactionRequest => {
  const id = randomUUID();
  return {
    idempotencyKey: options.idempotencyKey ?? `idem-${id}`,
    body: {
      providerId: options.providerId ?? TEST_PROVIDER_ID,
      externalTransactionId: options.externalTransactionId ?? `ext-${id}`,
      playerId: options.wallet.playerId,
      walletId: options.wallet.id,
      roundId: options.roundId ?? `round-${id}`,
      gameId: options.gameId ?? FIXTURE_GAME_ID,
      kind,
      money: {
        amount: options.amount ?? FIXTURE_AMOUNT,
        currency: options.currency ?? FIXTURE_CURRENCY,
      },
      ...(options.referenceExternalTransactionId === undefined
        ? {}
        : { referenceExternalTransactionId: options.referenceExternalTransactionId }),
    },
  };
};

export const betCommand = (options: WagerCommandOptions): WagerTransactionRequest =>
  wagerCommand(WagerTransactionKind.Bet, options);

export const winCommand = (options: WagerCommandOptions): WagerTransactionRequest =>
  wagerCommand(WagerTransactionKind.Win, options);

export const lossCommand = (options: WagerCommandOptions): WagerTransactionRequest =>
  wagerCommand(WagerTransactionKind.Loss, options);

export const refundCommand = (options: ReversalCommandOptions): WagerTransactionRequest =>
  wagerCommand(WagerTransactionKind.Refund, options);

export const rollbackCommand = (options: ReversalCommandOptions): WagerTransactionRequest =>
  wagerCommand(WagerTransactionKind.Rollback, options);

export const toMessageData = (request: WagerTransactionRequest): WagerTransactionData => ({
  ...request.body,
  idempotencyKey: request.idempotencyKey,
});

export const submitViaApi = (
  baseUrl: string,
  providerToken: string,
  request: WagerTransactionRequest,
): Promise<Response> =>
  fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${providerToken}`,
      'Idempotency-Key': request.idempotencyKey,
    },
    body: JSON.stringify(request.body),
  });
