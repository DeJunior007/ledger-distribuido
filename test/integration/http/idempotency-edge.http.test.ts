import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { connect } from 'node:net';
import { Client } from 'pg';
import { pino } from 'pino';
import { IdGeneratorPort } from '@application/ports/id-generator.port';
import { CreateWalletUseCase } from '@application/use-cases/create-wallet.use-case';
import { contextEnricher } from '@infrastructure/observability/context-enricher';
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
import { betCommand, createWalletViaApi, submitViaApi } from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import { createTestApp } from '@test/support/test-app';
import type { TestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID } from '@test/support/test-issuer';

const OTHER_PROVIDER_ID = 'provider-b';
const PROBLEM_CONTENT_TYPE = 'application/problem+json';
const TRANSACTIONS_PATH = '/wagering/transactions';
const WALLET_ID_CALL = 3;

type Json = Readonly<Record<string, unknown>>;

interface RawResponse {
  readonly status: number;
  readonly body: Json;
}

class UnexpectedBodyError extends Error {
  constructor(body: unknown) {
    super(`expected a json object body, got ${JSON.stringify(body)}`);
    this.name = 'UnexpectedBodyError';
  }
}

class PlannedWalletIds extends IdGeneratorPort {
  private calls = 0;
  private readonly fallback = new Uuidv7IdGenerator();

  constructor(private readonly walletId: string) {
    super();
  }

  next(): string {
    this.calls += 1;
    return this.calls === WALLET_ID_CALL ? this.walletId : this.fallback.next();
  }
}

const isJson = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toJson = (value: unknown): Json => {
  if (!isJson(value)) {
    throw new UnexpectedBodyError(value);
  }
  return value;
};

const jsonOf = async (response: Response): Promise<Json> => toJson(await response.json());

let database: TestDatabase;
let app: TestApp;
let operatorToken: string;
let providerToken: string;
let otherProviderToken: string;

const queryRows = async (sql: string, params: readonly unknown[]): Promise<Json[]> => {
  const client = new Client({ connectionString: database.superuserUrl });
  await client.connect();
  try {
    const result = await client.query<Json>(sql, [...params]);
    return result.rows;
  } finally {
    await client.end();
  }
};

const transactionsByExternalId = (externalTransactionId: string): Promise<Json[]> =>
  queryRows(
    'select provider_id, idempotency_key from wager_transactions where external_transaction_id = $1 order by provider_id',
    [externalTransactionId],
  );

const transactionsByKey = (idempotencyKey: string): Promise<Json[]> =>
  queryRows(
    'select provider_id, external_transaction_id from wager_transactions where idempotency_key = $1 order by provider_id',
    [idempotencyKey],
  );

const postTransaction = (
  headers: Readonly<Record<string, string>>,
  body: string,
  token: string = providerToken,
): Promise<Response> =>
  fetch(`${app.baseUrl}${TRANSACTIONS_PATH}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, ...headers },
    body,
  });

const postWithKey = (idempotencyKey: string, body: string): Promise<Response> =>
  postTransaction({ 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body);

const postWallet = (body: string): Promise<Response> =>
  fetch(`${app.baseUrl}/wallets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${operatorToken}`, 'Content-Type': 'application/json' },
    body,
  });

const parseRawResponse = (raw: string): RawResponse => {
  const separator = raw.indexOf('\r\n\r\n');
  const [statusLine = ''] = raw.slice(0, separator).split('\r\n');
  const [, status = ''] = statusLine.split(' ');
  const parsed: unknown = JSON.parse(raw.slice(separator + 4));
  return { status: Number(status), body: toJson(parsed) };
};

const rawPost = (headerLines: readonly string[], body: string): Promise<RawResponse> => {
  const url = new URL(app.baseUrl);
  const request = [
    `POST ${TRANSACTIONS_PATH} HTTP/1.1`,
    `Host: ${url.host}`,
    'Connection: close',
    'Content-Type: application/json',
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    `Authorization: Bearer ${providerToken}`,
    ...headerLines,
    '',
    body,
  ].join('\r\n');
  const done: PromiseWithResolvers<RawResponse> = Promise.withResolvers();
  const chunks: Buffer[] = [];
  const socket = connect({ host: url.hostname, port: Number(url.port) }, () => {
    socket.write(request);
  });
  socket.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });
  socket.on('error', done.reject);
  socket.on('end', () => {
    try {
      done.resolve(parseRawResponse(Buffer.concat(chunks).toString('utf8')));
    } catch (error: unknown) {
      done.reject(error);
    }
  });
  return done.promise;
};

const expectProblem = async (response: Response, status: number, failureCode: string) => {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toStartWith(PROBLEM_CONTENT_TYPE);
  const body = await jsonOf(response);
  expect(body).toMatchObject({ status, failureCode });
  return body;
};

const freshWallet = (): Promise<TestWallet> => createWalletViaApi(app.baseUrl, operatorToken);

const balanceOf = async (walletId: string): Promise<unknown> => {
  const response = await fetch(`${app.baseUrl}/wallets/${walletId}`, {
    headers: { Authorization: `Bearer ${operatorToken}` },
  });
  return (await jsonOf(response)).balance;
};

const createWalletWithId = async (walletId: string, playerId: string): Promise<string> => {
  const useCase = new CreateWalletUseCase({
    uow: new MikroOrmUnitOfWork(app.orm, app.config),
    clock: new SystemClock(),
    ids: new PlannedWalletIds(walletId),
    hasher: new Sha256Hasher(),
    logger: new PinoLoggerAdapter(pino({ level: 'silent' })),
    metrics: new PromMetricsAdapter(createMetricsRegistry().metrics),
    tracer: new NoopTracer(),
    enrich: contextEnricher,
  });
  const correlationId = crypto.randomUUID();
  const view = await useCase.execute({
    playerId,
    initialBalance: { amount: '100.00', currency: 'BRL' },
    correlationId,
    causationId: correlationId,
  });
  return view.id;
};

const reorderedWithSpaces = (request: WagerTransactionRequest): string => {
  const { money, ...rest } = request.body;
  const reversed = Object.entries(rest)
    .reverse()
    .map(([key, value]) => `\n   "${key}"  :\t${JSON.stringify(value)}`);
  const moneyText = `\n  "money" : {  "currency" : "${money.currency}" ,  "amount":"${money.amount}"  }`;
  return `  {${[moneyText, ...reversed].join(' ,')}\n}  `;
};

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ roles: ['api'], env: { DATABASE_URL: database.appUrl } });
  operatorToken = await app.issuer.token({ role: 'operator' });
  providerToken = await app.issuer.token({ role: 'provider', providerId: TEST_PROVIDER_ID });
  otherProviderToken = await app.issuer.token({
    role: 'provider',
    providerId: OTHER_PROVIDER_ID,
  });
});

beforeEach(() => {
  registerCurrentDatabase(database.superuserUrl);
});

afterAll(async () => {
  await app.stop();
});

describe('canonical payload replay', () => {
  it('replays a body with keys in another order and different whitespace', async () => {
    const wallet = await freshWallet();
    const bet = betCommand({ wallet });
    const first = await jsonOf(await submitViaApi(app.baseUrl, providerToken, bet));
    expect(first).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });

    const replay = await postWithKey(bet.idempotencyKey, reorderedWithSpaces(bet));
    expect(replay.status).toBe(200);
    expect(await jsonOf(replay)).toEqual({ ...first, idempotentReplay: true });
    expect(await transactionsByKey(bet.idempotencyKey)).toHaveLength(1);
    expect(await balanceOf(wallet.id)).toEqual({ amount: '990.00', currency: 'BRL' });
  });

  it('replays uppercase walletId and playerId as the lowercase submission', async () => {
    const wallet = await freshWallet();
    const bet = betCommand({ wallet });
    const first = await jsonOf(await submitViaApi(app.baseUrl, providerToken, bet));
    expect(first).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });

    const replay = await postWithKey(
      bet.idempotencyKey,
      JSON.stringify({
        ...bet.body,
        walletId: wallet.id.toUpperCase(),
        playerId: wallet.playerId.toUpperCase(),
      }),
    );
    expect(replay.status).toBe(200);
    expect(await jsonOf(replay)).toEqual({ ...first, idempotentReplay: true });
    expect(await transactionsByKey(bet.idempotencyKey)).toHaveLength(1);
  });
});

describe('idempotency scope per provider', () => {
  it('applies the same Idempotency-Key once per provider', async () => {
    const wallet = await freshWallet();
    const idempotencyKey = `shared-${crypto.randomUUID()}`;
    const fromA = betCommand({ wallet, idempotencyKey });
    const fromB = betCommand({ wallet, idempotencyKey, providerId: OTHER_PROVIDER_ID });

    const first = await jsonOf(await submitViaApi(app.baseUrl, providerToken, fromA));
    const second = await jsonOf(await submitViaApi(app.baseUrl, otherProviderToken, fromB));

    expect(first).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
    expect(second).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
    expect(second.transactionId).not.toBe(first.transactionId);
    expect(await transactionsByKey(idempotencyKey)).toEqual([
      { provider_id: TEST_PROVIDER_ID, external_transaction_id: fromA.body.externalTransactionId },
      { provider_id: OTHER_PROVIDER_ID, external_transaction_id: fromB.body.externalTransactionId },
    ]);
    expect(await balanceOf(wallet.id)).toEqual({ amount: '980.00', currency: 'BRL' });
  });

  it('applies the same externalTransactionId once per provider', async () => {
    const wallet = await freshWallet();
    const externalTransactionId = `shared-ext-${crypto.randomUUID()}`;
    const fromA = betCommand({ wallet, externalTransactionId });
    const fromB = betCommand({ wallet, externalTransactionId, providerId: OTHER_PROVIDER_ID });

    const first = await jsonOf(await submitViaApi(app.baseUrl, providerToken, fromA));
    const second = await jsonOf(await submitViaApi(app.baseUrl, otherProviderToken, fromB));

    expect(first).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
    expect(second).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
    expect(second.transactionId).not.toBe(first.transactionId);
    expect(await transactionsByExternalId(externalTransactionId)).toEqual([
      { provider_id: TEST_PROVIDER_ID, idempotency_key: fromA.idempotencyKey },
      { provider_id: OTHER_PROVIDER_ID, idempotency_key: fromB.idempotencyKey },
    ]);
    expect(await balanceOf(wallet.id)).toEqual({ amount: '980.00', currency: 'BRL' });
  });
});

describe('Idempotency-Key header', () => {
  it('reads the header regardless of the case of its name', async () => {
    const wallet = await freshWallet();
    const bet = betCommand({ wallet });
    const first = await rawPost(
      [`IDEMPOTENCY-KEY: ${bet.idempotencyKey}`],
      JSON.stringify(bet.body),
    );
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });

    const replay = await rawPost(
      [`idempotency-key: ${bet.idempotencyKey}`],
      JSON.stringify(bet.body),
    );
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  it('trims spaces around the header value, so the padded key is the same key', async () => {
    const wallet = await freshWallet();
    const bet = betCommand({ wallet });
    const padded = await rawPost(
      [`Idempotency-Key:    ${bet.idempotencyKey}   `],
      JSON.stringify(bet.body),
    );
    expect(padded.status).toBe(200);
    expect(padded.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });

    const replay = await jsonOf(await submitViaApi(app.baseUrl, providerToken, bet));
    expect(replay).toEqual({ ...padded.body, idempotentReplay: true });
    expect(await transactionsByKey(bet.idempotencyKey)).toHaveLength(1);
  });

  it('rejects a duplicated header as MISSING_IDEMPOTENCY_KEY and records nothing', async () => {
    const wallet = await freshWallet();
    const bet = betCommand({ wallet });
    const body = JSON.stringify(bet.body);

    const sameValue = await rawPost(
      [`Idempotency-Key: ${bet.idempotencyKey}`, `Idempotency-Key: ${bet.idempotencyKey}`],
      body,
    );
    const otherValue = await rawPost(
      [`Idempotency-Key: ${bet.idempotencyKey}`, `Idempotency-Key: other-${bet.idempotencyKey}`],
      body,
    );

    for (const response of [sameValue, otherValue]) {
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ status: 400, failureCode: 'MISSING_IDEMPOTENCY_KEY' });
    }
    expect(await transactionsByKey(bet.idempotencyKey)).toEqual([]);
    const later = await jsonOf(await submitViaApi(app.baseUrl, providerToken, bet));
    expect(later).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
  });
});

describe('Content-Type of the request', () => {
  it('accepts application/json with charset utf-8', async () => {
    const wallet = await freshWallet();
    const bet = betCommand({ wallet });
    const response = await postTransaction(
      { 'Content-Type': 'application/json; charset=utf-8', 'Idempotency-Key': bet.idempotencyKey },
      JSON.stringify(bet.body),
    );
    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toMatchObject({ status: 'PROCESSED' });
  });

  it('rejects a utf-16 json body as INVALID_PAYLOAD and records nothing', async () => {
    const wallet = await freshWallet();
    const bet = betCommand({ wallet });
    const response = await fetch(`${app.baseUrl}${TRANSACTIONS_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${providerToken}`,
        'Content-Type': 'application/json; charset=utf-16le',
        'Idempotency-Key': bet.idempotencyKey,
      },
      body: Buffer.from(JSON.stringify(bet.body), 'utf16le'),
    });
    await expectProblem(response, 400, 'INVALID_PAYLOAD');
    expect(await transactionsByKey(bet.idempotencyKey)).toEqual([]);
  });

  it('rejects an unsupported charset as INVALID_PAYLOAD and records nothing', async () => {
    const wallet = await freshWallet();
    const bet = betCommand({ wallet });
    const response = await postTransaction(
      {
        'Content-Type': 'application/json; charset=iso-8859-1',
        'Idempotency-Key': bet.idempotencyKey,
      },
      JSON.stringify(bet.body),
    );
    await expectProblem(response, 400, 'INVALID_PAYLOAD');
    expect(await transactionsByKey(bet.idempotencyKey)).toEqual([]);
  });
});

type BodyBuilder = (request: WagerTransactionRequest) => string;

const plainBody = (request: WagerTransactionRequest): string => JSON.stringify(request.body);

const duplicatedKeyBodies: readonly (readonly [string, BodyBuilder])[] = [
  ['an OPENING kind before the real one', (r) => `{"kind":"OPENING",${plainBody(r).slice(1)}`],
  ['an OPENING kind after the real one', (r) => `${plainBody(r).slice(0, -1)},"kind":"OPENING"}`],
  ['a top-level key repeated with the same value', (r) => `{"kind":"BET",${plainBody(r).slice(1)}`],
  [
    'a key repeated with the same value inside money',
    (r) => plainBody(r).replace('"money":{', '"money":{"currency":"BRL",'),
  ],
  [
    'a key repeated in an object inside an array',
    (r) => `${plainBody(r).slice(0, -1)},"extra":[{"a":1},{"b":1,"b":2}]}`,
  ],
  [
    'a key repeated through an equivalent unicode escape',
    (r) => `{"\\u006bind":"BET",${plainBody(r).slice(1)}`,
  ],
];

describe('JSON document quirks', () => {
  for (const [label, build] of duplicatedKeyBodies) {
    it(`rejects ${label} as INVALID_PAYLOAD from the parser and records nothing`, async () => {
      const wallet = await freshWallet();
      const bet = betCommand({ wallet });
      const body = build(bet);
      expect(isJson(JSON.parse(body))).toBe(true);

      const response = await postWithKey(bet.idempotencyKey, body);
      const problem = await expectProblem(response, 400, 'INVALID_PAYLOAD');
      expect(problem.errors).toBeUndefined();
      expect(await transactionsByKey(bet.idempotencyKey)).toEqual([]);

      const later = await jsonOf(await submitViaApi(app.baseUrl, providerToken, bet));
      expect(later).toMatchObject({ status: 'PROCESSED', kind: 'BET', idempotentReplay: false });
    });
  }

  it('rejects a key repeated inside the wallet balance as INVALID_PAYLOAD', async () => {
    const playerId = crypto.randomUUID();
    const body = `{"playerId":"${playerId}","initialBalance":{"amount":"1.00","amount":"1.00","currency":"BRL"}}`;
    const problem = await expectProblem(await postWallet(body), 400, 'INVALID_PAYLOAD');
    expect(problem.errors).toBeUndefined();
    expect(await queryRows('select id from wallets where player_id = $1', [playerId])).toEqual([]);
  });

  it('rejects a __proto__ key in the transaction body as INVALID_PAYLOAD', async () => {
    const wallet = await freshWallet();
    const bet = betCommand({ wallet });
    const body = `{"__proto__":{"kind":"WIN"},${JSON.stringify(bet.body).slice(1)}`;
    await expectProblem(await postWithKey(bet.idempotencyKey, body), 400, 'INVALID_PAYLOAD');
    expect(await transactionsByKey(bet.idempotencyKey)).toEqual([]);
  });

  it('rejects a __proto__ key inside money as INVALID_PAYLOAD', async () => {
    const wallet = await freshWallet();
    const bet = betCommand({ wallet });
    const body = JSON.stringify(bet.body).replace('"money":{', '"money":{"__proto__":{},');
    await expectProblem(await postWithKey(bet.idempotencyKey, body), 400, 'INVALID_PAYLOAD');
  });

  it('rejects a __proto__ key in the wallet body as INVALID_PAYLOAD', async () => {
    const body = `{"__proto__":{"admin":true},"playerId":"${crypto.randomUUID()}","initialBalance":{"amount":"1.00","currency":"BRL"}}`;
    await expectProblem(await postWallet(body), 400, 'INVALID_PAYLOAD');
  });
});

describe('amount over HTTP', () => {
  const malformedAmounts: readonly string[] = [
    '0.1',
    '1.001',
    '1e2',
    '-0.00',
    '+1.00',
    '1,00',
    '00.10',
    '１.００',
    ' 1.00',
    '25.00\n',
  ];

  for (const amount of malformedAmounts) {
    it(`rejects ${JSON.stringify(amount)} as INVALID_MONEY on both routes`, async () => {
      const wallet = await freshWallet();
      const bet = betCommand({ wallet, amount });
      const transaction = await submitViaApi(app.baseUrl, providerToken, bet);
      await expectProblem(transaction, 400, 'INVALID_MONEY');

      const created = await postWallet(
        JSON.stringify({
          playerId: crypto.randomUUID(),
          initialBalance: { amount, currency: 'BRL' },
        }),
      );
      await expectProblem(created, 400, 'INVALID_MONEY');
      expect(await transactionsByKey(bet.idempotencyKey)).toEqual([]);
    });
  }

  it('accepts the largest storable amount when creating a wallet', async () => {
    const amount = '999999999999999999.99';
    const response = await postWallet(
      JSON.stringify({
        playerId: crypto.randomUUID(),
        initialBalance: { amount, currency: 'BRL' },
      }),
    );
    expect(response.status).toBe(201);
    const body = await jsonOf(response);
    expect(body.balance).toEqual({ amount, currency: 'BRL' });
    expect(typeof body.id).toBe('string');
    expect(await balanceOf(String(body.id))).toEqual({ amount, currency: 'BRL' });
  });

  it('rejects one unit above the largest storable amount as INVALID_MONEY', async () => {
    const response = await postWallet(
      JSON.stringify({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '1000000000000000000.00', currency: 'BRL' },
      }),
    );
    await expectProblem(response, 400, 'INVALID_MONEY');
  });
});

describe('currency over HTTP', () => {
  it('rejects a lowercase currency on POST /wallets as INVALID_MONEY', async () => {
    const response = await postWallet(
      JSON.stringify({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '1.00', currency: 'brl' },
      }),
    );
    await expectProblem(response, 400, 'INVALID_MONEY');
  });

  it('rejects JPY, a real ISO code outside the whitelist, as UNSUPPORTED_CURRENCY', async () => {
    const wallet = await freshWallet();
    const transaction = await submitViaApi(
      app.baseUrl,
      providerToken,
      betCommand({ wallet, currency: 'JPY' }),
    );
    await expectProblem(transaction, 400, 'UNSUPPORTED_CURRENCY');

    const created = await postWallet(
      JSON.stringify({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '1.00', currency: 'JPY' },
      }),
    );
    await expectProblem(created, 400, 'UNSUPPORTED_CURRENCY');
  });
});

describe('WALLET_NOT_FOUND before the wallet exists', () => {
  it('keeps replaying 422 for the key and frees the externalId for a new key', async () => {
    const walletId = new Uuidv7IdGenerator().next();
    const playerId = crypto.randomUUID();
    const bet = betCommand({ wallet: { id: walletId, playerId } });

    const missing = await submitViaApi(app.baseUrl, providerToken, bet);
    expect(missing.status).toBe(422);
    const missingBody = await jsonOf(missing);
    expect(missingBody).toMatchObject({
      transactionId: null,
      status: 'REJECTED',
      failureCode: 'WALLET_NOT_FOUND',
      balance: null,
      idempotentReplay: false,
    });

    expect(await createWalletWithId(walletId, playerId)).toBe(walletId);

    const replay = await submitViaApi(app.baseUrl, providerToken, bet);
    expect(replay.status).toBe(422);
    expect(await jsonOf(replay)).toEqual({ ...missingBody, idempotentReplay: true });
    expect(await transactionsByKey(bet.idempotencyKey)).toEqual([]);

    const retried = await submitViaApi(app.baseUrl, providerToken, {
      ...bet,
      idempotencyKey: `idem-${crypto.randomUUID()}`,
    });
    expect(retried.status).toBe(200);
    expect(await jsonOf(retried)).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '90.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await transactionsByExternalId(bet.body.externalTransactionId)).toHaveLength(1);
    expect(await balanceOf(walletId)).toEqual({ amount: '90.00', currency: 'BRL' });
  });
});
