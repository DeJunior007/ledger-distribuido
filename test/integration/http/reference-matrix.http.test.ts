import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import type { QueryResultRow } from 'pg';
import { FAILURE_CODE_METADATA, FailureCode } from '@domain/shared/failure-code';
import type { MoneyProps } from '@domain/shared/money';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import type {
  RequestWagerKind,
  WagerTransactionRequest,
} from '@interfaces/http/schemas/wager-transaction.schema';
import { registerCurrentDatabase } from '@test/support/current-database';
import {
  betCommand,
  createWalletViaApi,
  refundCommand,
  submitViaApi,
  wagerCommand,
} from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import { createTestApp } from '@test/support/test-app';
import type { TestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID } from '@test/support/test-issuer';
import { waitFor } from '@test/support/wait-for';

type Json = Readonly<Record<string, unknown>>;

type OutcomeStatus = 'PROCESSED' | 'PENDING_REFERENCE' | 'REJECTED';

const OTHER_PROVIDER_ID = 'provider-b';
const SHORT_TTL_MS = '3000';
const TTL_WAIT = { timeoutMs: 30_000, intervalMs: 100 } as const;
const STEP_AMOUNT = '10.00';

const HTTP_STATUS: Readonly<Record<OutcomeStatus, number>> = {
  PROCESSED: 200,
  PENDING_REFERENCE: 202,
  REJECTED: 422,
};

interface ExpectedDecision {
  readonly status: OutcomeStatus;
  readonly balance: MoneyProps;
  readonly failureCode?: FailureCode;
  readonly referenceTransactionId?: string;
  readonly moves?: boolean;
}

interface StoredTransaction {
  readonly id: string;
  readonly status: string;
  readonly failure_code: string | null;
  readonly reference_transaction_id: string | null;
}

class UnexpectedBodyError extends Error {
  constructor(body: unknown) {
    super(`expected a json object body, got ${JSON.stringify(body)}`);
    this.name = 'UnexpectedBodyError';
  }
}

class MissingRowError extends Error {
  constructor(what: string) {
    super(`${what} was not found`);
    this.name = 'MissingRowError';
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

const transactionIdOf = (body: Json): string => {
  if (typeof body.transactionId !== 'string') {
    throw new UnexpectedBodyError(body);
  }
  return body.transactionId;
};

const brl = (amount: string): MoneyProps => ({ amount, currency: 'BRL' });

const usd = (amount: string): MoneyProps => ({ amount, currency: 'USD' });

const failureFields = (code: FailureCode | undefined): Json =>
  code === undefined
    ? {}
    : {
        failureCode: code,
        retryable: FAILURE_CODE_METADATA[code].retryable,
        action: FAILURE_CODE_METADATA[code].action,
      };

const outcomeBody = (
  transactionId: string,
  request: WagerTransactionRequest,
  expected: ExpectedDecision,
  replay: boolean,
): Json => ({
  transactionId,
  status: expected.status,
  kind: request.body.kind,
  ...failureFields(expected.failureCode),
  balance: expected.balance,
  idempotentReplay: replay,
});

const eventsFor = (expected: ExpectedDecision): string[] => {
  switch (expected.status) {
    case 'REJECTED':
      return ['WagerTransactionRejected'];
    case 'PENDING_REFERENCE':
      return ['WagerTransactionPendingReference'];
    case 'PROCESSED':
      return expected.moves === false
        ? ['WagerTransactionProcessed']
        : ['WagerTransactionProcessed', 'WalletBalanceChanged'];
  }
};

const queryRows = async <Row extends QueryResultRow>(
  databaseUrl: string,
  sql: string,
  params: readonly unknown[],
): Promise<Row[]> => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<Row>(sql, [...params]);
    return result.rows;
  } finally {
    await client.end();
  }
};

interface Harness {
  readonly database: () => TestDatabase;
  readonly app: () => TestApp;
}

const harness = (env: Readonly<Record<string, string>>, withScheduler: boolean): Harness => {
  let database: TestDatabase | undefined;
  let app: TestApp | undefined;

  beforeAll(async () => {
    const created = await createTestDatabase();
    database = created;
    app = await createTestApp({
      roles: withScheduler ? ['api', 'scheduler'] : ['api'],
      env: { DATABASE_URL: created.appUrl, ...env },
    });
  });

  beforeEach(() => {
    if (database !== undefined) {
      registerCurrentDatabase(database.superuserUrl);
    }
  });

  afterAll(async () => {
    await app?.stop();
  });

  return {
    database: () => {
      if (database === undefined) {
        throw new MissingRowError('test database');
      }
      return database;
    },
    app: () => {
      if (app === undefined) {
        throw new MissingRowError('test app');
      }
      return app;
    },
  };
};

const toolsFor = (context: Harness) => {
  const rows = <Row extends QueryResultRow>(
    sql: string,
    params: readonly unknown[],
  ): Promise<Row[]> => queryRows<Row>(context.database().superuserUrl, sql, params);

  const tokenFor = (providerId: string): Promise<string> =>
    context.app().issuer.token({ role: 'provider', providerId });

  const submit = async (request: WagerTransactionRequest): Promise<Response> =>
    submitViaApi(context.app().baseUrl, await tokenFor(request.body.providerId), request);

  const newWallet = async (initialBalance: MoneyProps, playerId?: string): Promise<TestWallet> =>
    createWalletViaApi(
      context.app().baseUrl,
      await context.app().issuer.token({ role: 'operator' }),
      { initialBalance, ...(playerId === undefined ? {} : { playerId }) },
    );

  const walletOf = async (walletId: string): Promise<Json> => {
    const [wallet] = await rows<Json>(
      'select balance::text as balance, version from wallets where id = $1',
      [walletId],
    );
    if (wallet === undefined) {
      throw new MissingRowError(`wallet ${walletId}`);
    }
    return wallet;
  };

  const transactionOf = async (
    providerId: string,
    externalTransactionId: string,
  ): Promise<StoredTransaction | undefined> => {
    const [found] = await rows<StoredTransaction>(
      `select id, status, failure_code, reference_transaction_id from wager_transactions
        where provider_id = $1 and external_transaction_id = $2`,
      [providerId, externalTransactionId],
    );
    return found;
  };

  const ledgerLegsOf = async (transactionId: string): Promise<number> => {
    const [counted] = await rows<{ total: number }>(
      'select count(*)::int as total from ledger_entries where transaction_id = $1',
      [transactionId],
    );
    return counted?.total ?? 0;
  };

  const eventTypesOf = async (transactionId: string): Promise<string[]> => {
    const found = await rows<{ event_type: string }>(
      `select event_type from outbox_messages
        where payload->'data'->>'transactionId' = $1
        order by event_type`,
      [transactionId],
    );
    return found.map((row) => row.event_type);
  };

  const idempotencyOf = (request: WagerTransactionRequest): Promise<Json[]> =>
    rows<Json>(
      `select http_status, transaction_id, response_body from idempotency_records
        where provider_id = $1 and idempotency_key = $2`,
      [request.body.providerId, request.idempotencyKey],
    );

  const expectStored = async (
    transactionId: string,
    request: WagerTransactionRequest,
    expected: ExpectedDecision,
    events: readonly string[],
  ): Promise<void> => {
    expect(
      await rows(
        `select status, failure_code, reference_transaction_id,
                balance_snapshot_amount::text as snapshot_amount,
                balance_snapshot_currency as snapshot_currency
           from wager_transactions where id = $1`,
        [transactionId],
      ),
    ).toEqual([
      {
        status: expected.status,
        failure_code: expected.failureCode ?? null,
        reference_transaction_id: expected.referenceTransactionId ?? null,
        snapshot_amount: expected.balance.amount,
        snapshot_currency: expected.balance.currency,
      },
    ]);
    const movesBalance = expected.status === 'PROCESSED' && expected.moves !== false;
    expect(await ledgerLegsOf(transactionId)).toBe(movesBalance ? 2 : 0);
    expect(await eventTypesOf(transactionId)).toEqual([...events]);
    expect(await idempotencyOf(request)).toEqual([
      {
        http_status: HTTP_STATUS[expected.status],
        transaction_id: transactionId,
        response_body: outcomeBody(transactionId, request, expected, false),
      },
    ]);
  };

  const decide = async (
    request: WagerTransactionRequest,
    expected: ExpectedDecision,
  ): Promise<string> => {
    const first = await submit(request);
    expect(first.status).toBe(HTTP_STATUS[expected.status]);
    const body = await jsonOf(first);
    const transactionId = transactionIdOf(body);
    expect(body).toEqual(outcomeBody(transactionId, request, expected, false));

    const replay = await submit(request);
    expect(replay.status).toBe(HTTP_STATUS[expected.status]);
    expect(await jsonOf(replay)).toEqual(outcomeBody(transactionId, request, expected, true));

    await expectStored(transactionId, request, expected, eventsFor(expected));
    return transactionId;
  };

  const waitForRejection = async (
    providerId: string,
    externalTransactionId: string,
  ): Promise<StoredTransaction> => {
    let found: StoredTransaction | undefined;
    await waitFor(async () => {
      found = await transactionOf(providerId, externalTransactionId);
      return found?.status === 'REJECTED';
    }, TTL_WAIT);
    if (found === undefined) {
      throw new MissingRowError(externalTransactionId);
    }
    return found;
  };

  return {
    rows,
    submit,
    newWallet,
    walletOf,
    transactionOf,
    ledgerLegsOf,
    eventTypesOf,
    idempotencyOf,
    decide,
    waitForRejection,
  };
};

interface MatrixCase {
  readonly kind: RequestWagerKind;
  readonly referenceKind: RequestWagerKind;
  readonly chain: readonly RequestWagerKind[];
  readonly balance: string;
}

const STEP_BALANCE_DELTA: Readonly<Record<RequestWagerKind, number>> = {
  [WagerTransactionKind.Bet]: -10,
  [WagerTransactionKind.Win]: 10,
  [WagerTransactionKind.Loss]: 0,
  [WagerTransactionKind.Refund]: 10,
  [WagerTransactionKind.Rollback]: 10,
};

const MATRIX: readonly MatrixCase[] = [
  {
    kind: WagerTransactionKind.Refund,
    referenceKind: WagerTransactionKind.Win,
    chain: [WagerTransactionKind.Win],
    balance: '110.00',
  },
  {
    kind: WagerTransactionKind.Refund,
    referenceKind: WagerTransactionKind.Loss,
    chain: [WagerTransactionKind.Loss],
    balance: '100.00',
  },
  {
    kind: WagerTransactionKind.Rollback,
    referenceKind: WagerTransactionKind.Loss,
    chain: [WagerTransactionKind.Loss],
    balance: '100.00',
  },
  {
    kind: WagerTransactionKind.Rollback,
    referenceKind: WagerTransactionKind.Rollback,
    chain: [WagerTransactionKind.Bet, WagerTransactionKind.Rollback],
    balance: '100.00',
  },
  {
    kind: WagerTransactionKind.Win,
    referenceKind: WagerTransactionKind.Win,
    chain: [WagerTransactionKind.Win],
    balance: '110.00',
  },
  {
    kind: WagerTransactionKind.Loss,
    referenceKind: WagerTransactionKind.Loss,
    chain: [WagerTransactionKind.Loss],
    balance: '100.00',
  },
];

const formatBalance = (units: number): string => `${String(units)}.00`;

describe('reference matrix over http', () => {
  const context = harness({}, false);
  const tools = toolsFor(context);

  describe('INVALID_REFERENCE_KIND', () => {
    for (const entry of MATRIX) {
      it(`rejects a ${entry.kind} that references a ${entry.referenceKind}`, async () => {
        const wallet = await tools.newWallet(brl('100.00'));
        const roundId = `round-${crypto.randomUUID()}`;
        let previous: { externalTransactionId: string; transactionId: string } | undefined;
        let units = 100;
        for (const step of entry.chain) {
          units += STEP_BALANCE_DELTA[step];
          const request = wagerCommand(step, {
            wallet,
            roundId,
            amount: STEP_AMOUNT,
            ...(previous === undefined
              ? {}
              : { referenceExternalTransactionId: previous.externalTransactionId }),
          });
          const transactionId = await tools.decide(request, {
            status: 'PROCESSED',
            balance: brl(formatBalance(units)),
            moves: step !== WagerTransactionKind.Loss,
            ...(previous === undefined ? {} : { referenceTransactionId: previous.transactionId }),
          });
          previous = { externalTransactionId: request.body.externalTransactionId, transactionId };
        }
        if (previous === undefined) {
          throw new MissingRowError('reference');
        }
        expect(formatBalance(units)).toBe(entry.balance);

        await tools.decide(
          wagerCommand(entry.kind, {
            wallet,
            roundId,
            amount: STEP_AMOUNT,
            referenceExternalTransactionId: previous.externalTransactionId,
          }),
          {
            status: 'REJECTED',
            failureCode: FailureCode.InvalidReferenceKind,
            referenceTransactionId: previous.transactionId,
            balance: brl(entry.balance),
          },
        );
        expect(await tools.walletOf(wallet.id)).toEqual({
          balance: entry.balance,
          version: 1 + entry.chain.filter((step) => step !== WagerTransactionKind.Loss).length,
        });
      });
    }
  });

  describe('REFERENCE_MISMATCH', () => {
    const placeBet = async (
      wallet: TestWallet,
      roundId: string,
    ): Promise<{ bet: WagerTransactionRequest; betId: string }> => {
      const bet = betCommand({ wallet, roundId, amount: STEP_AMOUNT });
      const betId = await tools.decide(bet, { status: 'PROCESSED', balance: brl('90.00') });
      return { bet, betId };
    };

    it('rejects a refund sent for another round', async () => {
      const wallet = await tools.newWallet(brl('100.00'));
      const { bet, betId } = await placeBet(wallet, `round-${crypto.randomUUID()}`);
      await tools.decide(
        refundCommand({
          wallet,
          roundId: `round-${crypto.randomUUID()}`,
          amount: STEP_AMOUNT,
          referenceExternalTransactionId: bet.body.externalTransactionId,
        }),
        {
          status: 'REJECTED',
          failureCode: FailureCode.ReferenceMismatch,
          referenceTransactionId: betId,
          balance: brl('90.00'),
        },
      );
      expect(await tools.walletOf(wallet.id)).toEqual({ balance: '90.00', version: 2 });
    });

    it('rejects a refund sent to another wallet of the same player in another currency', async () => {
      const playerId = crypto.randomUUID();
      const brlWallet = await tools.newWallet(brl('100.00'), playerId);
      const usdWallet = await tools.newWallet(usd('100.00'), playerId);
      const roundId = `round-${crypto.randomUUID()}`;
      const { bet, betId } = await placeBet(brlWallet, roundId);
      await tools.decide(
        refundCommand({
          wallet: usdWallet,
          roundId,
          amount: STEP_AMOUNT,
          currency: 'USD',
          referenceExternalTransactionId: bet.body.externalTransactionId,
        }),
        {
          status: 'REJECTED',
          failureCode: FailureCode.ReferenceMismatch,
          referenceTransactionId: betId,
          balance: usd('100.00'),
        },
      );
      expect(await tools.walletOf(brlWallet.id)).toEqual({ balance: '90.00', version: 2 });
      expect(await tools.walletOf(usdWallet.id)).toEqual({ balance: '100.00', version: 1 });
    });

    it('rejects a refund sent by another player', async () => {
      const owner = await tools.newWallet(brl('100.00'));
      const stranger = await tools.newWallet(brl('100.00'));
      const roundId = `round-${crypto.randomUUID()}`;
      const { bet, betId } = await placeBet(owner, roundId);
      await tools.decide(
        refundCommand({
          wallet: stranger,
          roundId,
          amount: STEP_AMOUNT,
          referenceExternalTransactionId: bet.body.externalTransactionId,
        }),
        {
          status: 'REJECTED',
          failureCode: FailureCode.ReferenceMismatch,
          referenceTransactionId: betId,
          balance: brl('100.00'),
        },
      );
      expect(await tools.walletOf(owner.id)).toEqual({ balance: '90.00', version: 2 });
      expect(await tools.walletOf(stranger.id)).toEqual({ balance: '100.00', version: 1 });
    });
  });
});

describe('references resolved by the pending worker over http', () => {
  const context = harness({ PENDING_TTL_MS: SHORT_TTL_MS }, true);
  const tools = toolsFor(context);

  it('never resolves a reference to a transaction of another provider with the same external id', async () => {
    const wallet = await tools.newWallet(brl('100.00'));
    const roundId = `round-${crypto.randomUUID()}`;
    const sharedExternalId = `shared-${crypto.randomUUID()}`;
    const foreignBet = betCommand({
      wallet,
      roundId,
      amount: STEP_AMOUNT,
      providerId: OTHER_PROVIDER_ID,
      externalTransactionId: sharedExternalId,
    });
    const foreignBetId = await tools.decide(foreignBet, {
      status: 'PROCESSED',
      balance: brl('90.00'),
    });

    const refund = refundCommand({
      wallet,
      roundId,
      amount: STEP_AMOUNT,
      referenceExternalTransactionId: sharedExternalId,
    });
    const accepted = await tools.submit(refund);
    expect(accepted.status).toBe(202);
    const acceptedBody = await jsonOf(accepted);
    const refundId = transactionIdOf(acceptedBody);
    expect(acceptedBody).toEqual(
      outcomeBody(refundId, refund, { status: 'PENDING_REFERENCE', balance: brl('90.00') }, false),
    );

    const rejected = await tools.waitForRejection(
      TEST_PROVIDER_ID,
      refund.body.externalTransactionId,
    );
    expect(rejected).toEqual({
      id: refundId,
      status: 'REJECTED',
      failure_code: FailureCode.ReferenceNotFound,
      reference_transaction_id: null,
    });
    const expected: ExpectedDecision = {
      status: 'REJECTED',
      failureCode: FailureCode.ReferenceNotFound,
      balance: brl('90.00'),
    };
    const replay = await tools.submit(refund);
    expect(replay.status).toBe(422);
    expect(await jsonOf(replay)).toEqual(outcomeBody(refundId, refund, expected, true));
    expect(await tools.ledgerLegsOf(refundId)).toBe(0);
    expect(await tools.eventTypesOf(refundId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    expect(await tools.idempotencyOf(refund)).toEqual([
      {
        http_status: 422,
        transaction_id: refundId,
        response_body: outcomeBody(refundId, refund, expected, false),
      },
    ]);
    expect(await tools.transactionOf(OTHER_PROVIDER_ID, sharedExternalId)).toEqual({
      id: foreignBetId,
      status: 'PROCESSED',
      failure_code: null,
      reference_transaction_id: null,
    });
    expect(await tools.walletOf(wallet.id)).toEqual({ balance: '90.00', version: 2 });
  });

  it('keeps a late refund rejected by the deadline and processes a new one after the bet arrives', async () => {
    const wallet = await tools.newWallet(brl('100.00'));
    const roundId = `round-${crypto.randomUUID()}`;
    const bet = betCommand({ wallet, roundId, amount: STEP_AMOUNT });
    const refund = refundCommand({
      wallet,
      roundId,
      amount: STEP_AMOUNT,
      referenceExternalTransactionId: bet.body.externalTransactionId,
    });

    const accepted = await tools.submit(refund);
    expect(accepted.status).toBe(202);
    const refundId = transactionIdOf(await jsonOf(accepted));
    const rejected = await tools.waitForRejection(
      TEST_PROVIDER_ID,
      refund.body.externalTransactionId,
    );
    expect(rejected).toEqual({
      id: refundId,
      status: 'REJECTED',
      failure_code: FailureCode.ReferenceNotFound,
      reference_transaction_id: null,
    });
    const rejectedOutcome: ExpectedDecision = {
      status: 'REJECTED',
      failureCode: FailureCode.ReferenceNotFound,
      balance: brl('100.00'),
    };

    const betId = await tools.decide(bet, { status: 'PROCESSED', balance: brl('90.00') });

    const replay = await tools.submit(refund);
    expect(replay.status).toBe(422);
    expect(await jsonOf(replay)).toEqual(outcomeBody(refundId, refund, rejectedOutcome, true));
    expect(await tools.transactionOf(TEST_PROVIDER_ID, refund.body.externalTransactionId)).toEqual(
      rejected,
    );

    const otherKey = { ...refund, idempotencyKey: `idem-${crypto.randomUUID()}` };
    const conflict = await tools.submit(otherKey);
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get('content-type')).toStartWith('application/problem+json');
    const conflictBody = await jsonOf(conflict);
    expect(conflictBody).toMatchObject({
      status: 409,
      failureCode: FailureCode.ExternalTransactionIdConflict,
      retryable: FAILURE_CODE_METADATA[FailureCode.ExternalTransactionIdConflict].retryable,
      action: FAILURE_CODE_METADATA[FailureCode.ExternalTransactionIdConflict].action,
      transactionId: refundId,
      idempotentReplay: false,
    });
    expect(await tools.idempotencyOf(otherKey)).toEqual([
      { http_status: 409, transaction_id: null, response_body: conflictBody },
    ]);

    const freshRefund = refundCommand({
      wallet,
      roundId,
      amount: STEP_AMOUNT,
      referenceExternalTransactionId: bet.body.externalTransactionId,
    });
    await tools.decide(freshRefund, {
      status: 'PROCESSED',
      referenceTransactionId: betId,
      balance: brl('100.00'),
    });

    expect(await tools.ledgerLegsOf(refundId)).toBe(0);
    expect(await tools.eventTypesOf(refundId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    expect(await tools.idempotencyOf(refund)).toEqual([
      {
        http_status: 422,
        transaction_id: refundId,
        response_body: outcomeBody(refundId, refund, rejectedOutcome, false),
      },
    ]);
    expect(await tools.walletOf(wallet.id)).toEqual({ balance: '100.00', version: 3 });
  });
});
