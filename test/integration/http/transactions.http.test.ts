import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import type { SubmitWagerTransactionCommand } from '@application/commands/submit-wager-transaction.command';
import { TRUSTED_CHANNEL } from '@application/ports/provider-identity.port';
import { OutcomeMapper } from '@application/services/outcome-mapper';
import { MarkTransactionFailedUseCase } from '@application/use-cases/mark-transaction-failed.use-case';
import { FAILURE_CODE_METADATA, FailureCode } from '@domain/shared/failure-code';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { contextEnricher } from '@infrastructure/observability/context-enricher';
import { createLogger } from '@infrastructure/observability/logger';
import { createMetricsRegistry } from '@infrastructure/observability/metrics.registry';
import { PinoLoggerAdapter } from '@infrastructure/observability/pino-logger.adapter';
import { PromMetricsAdapter } from '@infrastructure/observability/prom-metrics.adapter';
import { MikroOrmUnitOfWork } from '@infrastructure/persistence/mikro-orm-unit-of-work';
import { NoopTracer } from '@infrastructure/system/noop-tracer';
import { Sha256Hasher } from '@infrastructure/system/sha256-hasher';
import { SystemClock } from '@infrastructure/system/system-clock';
import { Uuidv7IdGenerator } from '@infrastructure/system/uuidv7-id-generator';
import type { WagerTransactionRequest } from '@interfaces/http/schemas/wager-transaction.schema';
import { registerCurrentDatabase } from '@test/support/current-database';
import { breakLedgerWrites, restoreGrants } from '@test/support/deterministic-failure';
import {
  betCommand,
  createWalletViaApi,
  refundCommand,
  rollbackCommand,
  submitViaApi,
  walletRequest,
  winCommand,
} from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import { createTestApp } from '@test/support/test-app';
import type { TestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID } from '@test/support/test-issuer';
import { waitFor } from '@test/support/wait-for';

type Json = Readonly<Record<string, unknown>>;

const OTHER_PROVIDER_ID = 'provider-b';
const PROBLEM_CONTENT_TYPE = 'application/problem+json';
const LOCK_WAIT = { timeoutMs: 5_000, intervalMs: 20 } as const;

class UnexpectedBodyError extends Error {
  constructor(body: unknown) {
    super(`expected a json object body, got ${JSON.stringify(body)}`);
    this.name = 'UnexpectedBodyError';
  }
}

const isJson = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const jsonOf = async (response: Response): Promise<Json> => {
  const parsed: unknown = await response.json();
  if (!isJson(parsed)) {
    throw new UnexpectedBodyError(parsed);
  }
  return parsed;
};

const metadataOf = (code: FailureCode): { retryable: boolean; action: string } => ({
  retryable: FAILURE_CODE_METADATA[code].retryable,
  action: FAILURE_CODE_METADATA[code].action,
});

const problemOf = (status: number, code: FailureCode): Json => ({
  status,
  failureCode: code,
  ...metadataOf(code),
});

const expectProblem = async (response: Response, status: number, code: FailureCode) => {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toStartWith(PROBLEM_CONTENT_TYPE);
  const body = await jsonOf(response);
  expect(body).toMatchObject(problemOf(status, code));
  expect(typeof body.type).toBe('string');
  expect(typeof body.title).toBe('string');
  expect(typeof body.detail).toBe('string');
  return body;
};

const sameFields = (actual: Json, expected: Json, replay: boolean): void => {
  for (const [key, value] of Object.entries(expected)) {
    if (key !== 'idempotentReplay') {
      expect(actual[key]).toEqual(value);
    }
  }
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  expect(actual.idempotentReplay).toBe(replay);
};

const postRaw = (
  baseUrl: string,
  headers: Readonly<Record<string, string>>,
  body: unknown,
): Promise<Response> =>
  fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const queryRows = async (
  databaseUrl: string,
  sql: string,
  params: readonly unknown[],
): Promise<Json[]> => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<Json>(sql, [...params]);
    return result.rows;
  } finally {
    await client.end();
  }
};

const storedCount = async (database: TestDatabase, idempotencyKey: string): Promise<number> => {
  const rows = await queryRows(
    database.superuserUrl,
    `select (select count(*) from wager_transactions where provider_id = $1 and idempotency_key = $2)
          + (select count(*) from idempotency_records where provider_id = $1 and idempotency_key = $2)
       as total`,
    [TEST_PROVIDER_ID, idempotencyKey],
  );
  return Number(rows[0]?.total);
};

const toFailedCommand = (request: WagerTransactionRequest): SubmitWagerTransactionCommand => {
  const correlationId = crypto.randomUUID();
  return {
    channel: 'sqs',
    identity: TRUSTED_CHANNEL,
    providerId: request.body.providerId,
    externalTransactionId: request.body.externalTransactionId,
    idempotencyKey: request.idempotencyKey,
    playerId: request.body.playerId,
    walletId: request.body.walletId,
    roundId: request.body.roundId,
    gameId: request.body.gameId,
    kind: request.body.kind,
    money: request.body.money,
    referenceExternalTransactionId: request.body.referenceExternalTransactionId,
    correlationId,
    causationId: correlationId,
    inbox: {
      messageId: crypto.randomUUID(),
      payloadHash: new Sha256Hasher().sha256Hex(JSON.stringify(request)),
    },
  };
};

const markFailedUseCase = (app: TestApp): MarkTransactionFailedUseCase =>
  new MarkTransactionFailedUseCase({
    uow: new MikroOrmUnitOfWork(app.orm, app.config),
    clock: new SystemClock(),
    ids: new Uuidv7IdGenerator(),
    hasher: new Sha256Hasher(),
    logger: new PinoLoggerAdapter(
      createLogger({ level: 'silent', service: 'transactions-http', instanceId: 'test' }),
    ),
    metrics: new PromMetricsAdapter(createMetricsRegistry().metrics),
    tracer: new NoopTracer(),
    enrich: contextEnricher,
    outcomeMapper: new OutcomeMapper(),
  });

describe('POST /wagering/transactions status map', () => {
  let database: TestDatabase;
  let app: TestApp;
  let providerToken: string;
  let otherProviderToken: string;
  let operatorToken: string;

  const submit = (request: WagerTransactionRequest, token = providerToken): Promise<Response> =>
    submitViaApi(app.baseUrl, token, request);

  const newWallet = (initialAmount = '100.00'): Promise<TestWallet> =>
    createWalletViaApi(app.baseUrl, operatorToken, {
      initialBalance: { amount: initialAmount, currency: 'BRL' },
    });

  beforeAll(async () => {
    database = await createTestDatabase();
    app = await createTestApp({
      roles: ['api'],
      env: { DATABASE_URL: database.appUrl, DB_LOCK_TIMEOUT_MS: '300' },
    });
    providerToken = await app.issuer.token({ role: 'provider', providerId: TEST_PROVIDER_ID });
    otherProviderToken = await app.issuer.token({
      role: 'provider',
      providerId: OTHER_PROVIDER_ID,
    });
    operatorToken = await app.issuer.token({ role: 'operator' });
  });

  beforeEach(() => {
    registerCurrentDatabase(database.superuserUrl);
  });

  afterAll(async () => {
    await app.stop();
  });

  it('answers 200 for a processed transaction and replays it with the same status', async () => {
    const wallet = await newWallet();
    const bet = betCommand({ wallet, amount: '25.00' });
    const first = await submit(bet);
    expect(first.status).toBe(200);
    const body = await jsonOf(first);
    expect(body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      kind: WagerTransactionKind.Bet,
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    });

    const replay = await submit(bet);
    expect(replay.status).toBe(200);
    sameFields(await jsonOf(replay), body, true);
  });

  it('answers 201 when an operator creates a wallet', async () => {
    const response = await fetch(`${app.baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${operatorToken}` },
      body: JSON.stringify(walletRequest()),
    });
    expect(response.status).toBe(201);
    expect(await jsonOf(response)).toMatchObject({
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
  });

  it('answers 202 for a reversal whose reference is not known yet and replays it', async () => {
    const wallet = await newWallet();
    const refund = refundCommand({ wallet, referenceExternalTransactionId: 'ext-not-yet-seen' });
    const first = await submit(refund);
    expect(first.status).toBe(202);
    const body = await jsonOf(first);
    expect(typeof body.transactionId).toBe('string');
    expect(body).toMatchObject({
      status: 'PENDING_REFERENCE',
      kind: WagerTransactionKind.Refund,
      idempotentReplay: false,
    });

    const replay = await submit(refund);
    expect(replay.status).toBe(202);
    sameFields(await jsonOf(replay), body, true);
  });

  describe('400 for each validation code', () => {
    it('answers MISSING_IDEMPOTENCY_KEY when the header is absent', async () => {
      const wallet = await newWallet();
      const bet = betCommand({ wallet });
      const response = await postRaw(
        app.baseUrl,
        { Authorization: `Bearer ${providerToken}` },
        bet.body,
      );
      await expectProblem(response, 400, FailureCode.MissingIdempotencyKey);
    });

    it('answers UNSUPPORTED_KIND for an OPENING kind', async () => {
      const wallet = await newWallet();
      const bet = betCommand({ wallet });
      const response = await postRaw(
        app.baseUrl,
        { Authorization: `Bearer ${providerToken}`, 'Idempotency-Key': bet.idempotencyKey },
        { ...bet.body, kind: WagerTransactionKind.Opening },
      );
      await expectProblem(response, 400, FailureCode.UnsupportedKind);
    });

    it('answers INVALID_MONEY for a malformed amount', async () => {
      const wallet = await newWallet();
      const response = await submit(betCommand({ wallet, amount: '10.5' }));
      const body = await expectProblem(response, 400, FailureCode.InvalidMoney);
      expect(body.errors).toMatchObject([{ path: 'body.money.amount' }]);
    });

    it('answers UNSUPPORTED_CURRENCY for a currency outside the whitelist', async () => {
      const wallet = await newWallet();
      const response = await submit(betCommand({ wallet, currency: 'XYZ' }));
      await expectProblem(response, 400, FailureCode.UnsupportedCurrency);
    });

    it('answers INVALID_AMOUNT for a zero bet', async () => {
      const wallet = await newWallet();
      const response = await submit(betCommand({ wallet, amount: '0.00' }));
      await expectProblem(response, 400, FailureCode.InvalidAmount);
    });

    it('answers REFERENCE_REQUIRED for a rollback without a reference', async () => {
      const wallet = await newWallet();
      const bet = betCommand({ wallet });
      const response = await submit({
        ...bet,
        body: { ...bet.body, kind: WagerTransactionKind.Rollback },
      });
      await expectProblem(response, 400, FailureCode.ReferenceRequired);
    });

    it('answers INVALID_PAYLOAD for an unknown field', async () => {
      const wallet = await newWallet();
      const bet = betCommand({ wallet });
      const response = await postRaw(
        app.baseUrl,
        { Authorization: `Bearer ${providerToken}`, 'Idempotency-Key': bet.idempotencyKey },
        { ...bet.body, unexpected: 'field' },
      );
      await expectProblem(response, 400, FailureCode.InvalidPayload);
    });
  });

  it('answers 401 with WWW-Authenticate when the token is missing or invalid', async () => {
    const wallet = await newWallet();
    const bet = betCommand({ wallet });
    const withoutToken = await postRaw(
      app.baseUrl,
      { 'Idempotency-Key': bet.idempotencyKey },
      bet.body,
    );
    await expectProblem(withoutToken, 401, FailureCode.Unauthenticated);
    expect(withoutToken.headers.get('www-authenticate')).toStartWith('Bearer');

    const withBadToken = await submit(bet, 'not-a-jwt');
    await expectProblem(withBadToken, 401, FailureCode.Unauthenticated);
    expect(withBadToken.headers.get('www-authenticate')).toStartWith('Bearer');
    expect(await storedCount(database, bet.idempotencyKey)).toBe(0);
  });

  it('answers 403 FORBIDDEN for an operator and PROVIDER_IDENTITY_MISMATCH for another provider', async () => {
    const wallet = await newWallet();
    const bet = betCommand({ wallet });
    await expectProblem(await submit(bet, operatorToken), 403, FailureCode.Forbidden);
    await expectProblem(
      await submit(bet, otherProviderToken),
      403,
      FailureCode.ProviderIdentityMismatch,
    );
    expect(await storedCount(database, bet.idempotencyKey)).toBe(0);
  });

  it('answers 404 NOT_FOUND when a queried transaction does not exist', async () => {
    const byId = await fetch(`${app.baseUrl}/wagering/transactions/${crypto.randomUUID()}`, {
      headers: { Authorization: `Bearer ${providerToken}` },
    });
    await expectProblem(byId, 404, FailureCode.NotFound);

    const byExternalId = await fetch(
      `${app.baseUrl}/providers/${TEST_PROVIDER_ID}/wagering/transactions/ext-unknown`,
      { headers: { Authorization: `Bearer ${providerToken}` } },
    );
    await expectProblem(byExternalId, 404, FailureCode.NotFound);
  });

  it('answers 409 IDEMPOTENCY_KEY_CONFLICT when a key is reused with another payload', async () => {
    const wallet = await newWallet();
    const bet = betCommand({ wallet, amount: '5.00' });
    expect((await submit(bet)).status).toBe(200);
    const response = await submit({
      ...bet,
      body: { ...bet.body, money: { amount: '6.00', currency: 'BRL' } },
    });
    const body = await expectProblem(response, 409, FailureCode.IdempotencyKeyConflict);
    expect(body.transactionId).toBeUndefined();
  });

  it('answers 409 EXTERNAL_TRANSACTION_ID_CONFLICT with the existing transaction id', async () => {
    const wallet = await newWallet();
    const bet = betCommand({ wallet, amount: '5.00' });
    const first = await jsonOf(await submit(bet));
    const response = await submit({ ...bet, idempotencyKey: `idem-${crypto.randomUUID()}` });
    const body = await expectProblem(response, 409, FailureCode.ExternalTransactionIdConflict);
    expect(body.transactionId).toBe(first.transactionId);
  });

  it('answers 409 WALLET_ALREADY_EXISTS for a duplicated wallet', async () => {
    const request = walletRequest();
    const create = (): Promise<Response> =>
      fetch(`${app.baseUrl}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${operatorToken}` },
        body: JSON.stringify(request),
      });
    const created = await jsonOf(await create());
    const body = await expectProblem(await create(), 409, FailureCode.WalletAlreadyExists);
    expect(body.walletId).toBe(created.id);
  });

  it('answers 422 for a business rejection and replays it with the same status', async () => {
    const wallet = await newWallet('20.00');
    const bet = betCommand({ wallet, amount: '25.00' });
    const first = await submit(bet);
    expect(first.status).toBe(422);
    expect(first.headers.get('content-type')).toStartWith('application/json');
    const body = await jsonOf(first);
    expect(body).toEqual({
      transactionId: expect.any(String),
      status: 'REJECTED',
      kind: WagerTransactionKind.Bet,
      failureCode: FailureCode.InsufficientFunds,
      ...metadataOf(FailureCode.InsufficientFunds),
      balance: { amount: '20.00', currency: 'BRL' },
      idempotentReplay: false,
    });

    const replay = await submit(bet);
    expect(replay.status).toBe(422);
    sameFields(await jsonOf(replay), body, true);
  });

  it('answers 422 WALLET_NOT_FOUND with null transaction id and balance', async () => {
    const bet = betCommand({ wallet: { id: crypto.randomUUID(), playerId: crypto.randomUUID() } });
    const first = await submit(bet);
    expect(first.status).toBe(422);
    const body = await jsonOf(first);
    expect(body).toEqual({
      transactionId: null,
      status: 'REJECTED',
      kind: WagerTransactionKind.Bet,
      failureCode: FailureCode.WalletNotFound,
      ...metadataOf(FailureCode.WalletNotFound),
      balance: null,
      idempotentReplay: false,
    });
    const transactions = await queryRows(
      database.superuserUrl,
      'select id from wager_transactions where provider_id = $1 and external_transaction_id = $2',
      [TEST_PROVIDER_ID, bet.body.externalTransactionId],
    );
    expect(transactions).toEqual([]);

    const replay = await submit(bet);
    expect(replay.status).toBe(422);
    sameFields(await jsonOf(replay), body, true);
  });

  it('answers 500 PROCESSING_FAILED on the replay of a transaction marked as failed', async () => {
    const wallet = await newWallet();
    const win = winCommand({ wallet, amount: '15.00' });
    const marked = await markFailedUseCase(app).execute(toFailedCommand(win));
    expect(marked).toMatchObject({ kind: 'outcome', httpStatus: 500 });

    const replay = await submit(win);
    expect(replay.status).toBe(500);
    expect(replay.headers.get('content-type')).toStartWith('application/json');
    const body = await jsonOf(replay);
    expect(body).toEqual({
      transactionId: expect.any(String),
      status: 'FAILED',
      kind: WagerTransactionKind.Win,
      failureCode: FailureCode.ProcessingFailed,
      ...metadataOf(FailureCode.ProcessingFailed),
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: true,
    });
    expect(metadataOf(FailureCode.ProcessingFailed).action).toBe('GIVE_UP');
    const stored = await queryRows(
      database.superuserUrl,
      'select id, status from wager_transactions where provider_id = $1 and idempotency_key = $2',
      [TEST_PROVIDER_ID, win.idempotencyKey],
    );
    expect(stored).toEqual([{ id: body.transactionId, status: 'FAILED' }]);
  });

  it('answers 503 INTERNAL_ERROR with Retry-After and records nothing on an unexpected error', async () => {
    const wallet = await newWallet();
    const bet = betCommand({ wallet });
    await breakLedgerWrites(database);
    try {
      const response = await submit(bet);
      await expectProblem(response, 503, FailureCode.InternalError);
      expect(response.headers.get('retry-after')).toBe('5');
    } finally {
      await restoreGrants(database);
    }
    expect(await storedCount(database, bet.idempotencyKey)).toBe(0);
  });

  it('answers 503 INFRASTRUCTURE_UNAVAILABLE with Retry-After while the wallet lock is held', async () => {
    const wallet = await newWallet();
    const bet = betCommand({ wallet });
    const holder = new Client({ connectionString: database.superuserUrl });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [wallet.id]);
      const pending = submit(bet);
      await waitFor(async () => {
        const waiting = await queryRows(
          database.superuserUrl,
          `select count(*) as total from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'`,
          [],
        );
        return Number(waiting[0]?.total) >= 1;
      }, LOCK_WAIT);
      const response = await pending;
      await expectProblem(response, 503, FailureCode.InfrastructureUnavailable);
      expect(response.headers.get('retry-after')).toBe('1');
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
    expect(await storedCount(database, bet.idempotencyKey)).toBe(0);

    const retried = await submit(bet);
    expect(retried.status).toBe(200);
    expect(await jsonOf(retried)).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
  });
});

describe('GET wager transactions', () => {
  let database: TestDatabase;
  let app: TestApp;
  let providerToken: string;
  let operatorToken: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    app = await createTestApp({ roles: ['api'], env: { DATABASE_URL: database.appUrl } });
    providerToken = await app.issuer.token({ role: 'provider', providerId: TEST_PROVIDER_ID });
    operatorToken = await app.issuer.token({ role: 'operator' });
  });

  beforeEach(() => {
    registerCurrentDatabase(database.superuserUrl);
  });

  afterAll(async () => {
    await app.stop();
  });

  const getJson = async (path: string, token: string): Promise<Json> => {
    const response = await fetch(`${app.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    return jsonOf(response);
  };

  it('returns a processed bet by id and by external id', async () => {
    const wallet = await createWalletViaApi(app.baseUrl, operatorToken, {
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const bet = betCommand({ wallet, amount: '25.00' });
    const submitted = await jsonOf(await submitViaApi(app.baseUrl, providerToken, bet));
    const expected: Json = {
      id: submitted.transactionId,
      providerId: TEST_PROVIDER_ID,
      externalTransactionId: bet.body.externalTransactionId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: bet.body.roundId,
      gameId: bet.body.gameId,
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      createdAt: expect.any(String),
      processedAt: expect.any(String),
    };

    const byId = await getJson(
      `/wagering/transactions/${String(submitted.transactionId)}`,
      providerToken,
    );
    expect(byId).toEqual(expected);
    expect(
      await getJson(`/wagering/transactions/${String(submitted.transactionId)}`, operatorToken),
    ).toEqual(expected);

    const externalPath = `/providers/${TEST_PROVIDER_ID}/wagering/transactions/${bet.body.externalTransactionId}`;
    expect(await getJson(externalPath, providerToken)).toEqual(expected);
    expect(await getJson(externalPath, operatorToken)).toEqual(expected);
  });

  it('returns the reference fields of a processed rollback', async () => {
    const wallet = await createWalletViaApi(app.baseUrl, operatorToken, {
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const bet = betCommand({ wallet, amount: '25.00' });
    const placed = await jsonOf(await submitViaApi(app.baseUrl, providerToken, bet));
    const rollback = rollbackCommand({
      wallet,
      amount: '25.00',
      roundId: bet.body.roundId,
      referenceExternalTransactionId: bet.body.externalTransactionId,
    });
    const reversed = await jsonOf(await submitViaApi(app.baseUrl, providerToken, rollback));
    expect(reversed).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });

    const byId = await getJson(
      `/wagering/transactions/${String(reversed.transactionId)}`,
      providerToken,
    );
    expect(byId).toMatchObject({
      id: reversed.transactionId,
      kind: WagerTransactionKind.Rollback,
      status: 'PROCESSED',
      referenceExternalTransactionId: bet.body.externalTransactionId,
      referenceTransactionId: placed.transactionId,
    });
    expect(byId.failureCode).toBeUndefined();
  });
});
