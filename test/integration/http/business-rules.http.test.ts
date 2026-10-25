import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import type { QueryResultRow } from 'pg';
import { FAILURE_CODE_METADATA, FailureCode } from '@domain/shared/failure-code';
import type { MoneyProps } from '@domain/shared/money';
import type { WagerTransactionRequest } from '@interfaces/http/schemas/wager-transaction.schema';
import { registerCurrentDatabase } from '@test/support/current-database';
import {
  betCommand,
  createWalletViaApi,
  lossCommand,
  refundCommand,
  rollbackCommand,
  submitViaApi,
  winCommand,
} from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import { createTestApp } from '@test/support/test-app';
import type { TestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';
import { TEST_PROVIDER_ID } from '@test/support/test-issuer';

type Json = Readonly<Record<string, unknown>>;

type OutcomeStatus = 'PROCESSED' | 'PENDING_REFERENCE' | 'REJECTED';

const MAX_BALANCE = '999999999999999999.99';
const PROCESSED_WITH_MOVEMENT = ['WagerTransactionProcessed', 'WalletBalanceChanged'];
const PROCESSED_WITHOUT_MOVEMENT = ['WagerTransactionProcessed'];
const REJECTED_ONLY = ['WagerTransactionRejected'];
const PENDING_ONLY = ['WagerTransactionPendingReference'];

const HTTP_STATUS: Readonly<Record<OutcomeStatus, number>> = {
  PROCESSED: 200,
  PENDING_REFERENCE: 202,
  REJECTED: 422,
};

interface WalletEntry {
  readonly direction: 'DEBIT' | 'CREDIT';
  readonly amount: string;
}

interface ExpectedDecision {
  readonly status: OutcomeStatus;
  readonly balance: MoneyProps;
  readonly failureCode?: FailureCode;
  readonly referenceTransactionId?: string;
  readonly walletEntry?: WalletEntry;
}

interface StoredWallet {
  readonly balance: string;
  readonly version: number;
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

const opposite = (direction: WalletEntry['direction']): WalletEntry['direction'] =>
  direction === 'DEBIT' ? 'CREDIT' : 'DEBIT';

const defaultEvents = (expected: ExpectedDecision): readonly string[] => {
  switch (expected.status) {
    case 'REJECTED':
      return REJECTED_ONLY;
    case 'PENDING_REFERENCE':
      return PENDING_ONLY;
    case 'PROCESSED':
      return expected.walletEntry === undefined
        ? PROCESSED_WITHOUT_MOVEMENT
        : PROCESSED_WITH_MOVEMENT;
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

describe('business rules over http', () => {
  let database: TestDatabase;
  let app: TestApp;
  let providerToken: string;
  let operatorToken: string;

  const rows = <Row extends QueryResultRow>(
    sql: string,
    params: readonly unknown[],
  ): Promise<Row[]> => queryRows<Row>(database.superuserUrl, sql, params);

  const submit = (request: WagerTransactionRequest): Promise<Response> =>
    submitViaApi(app.baseUrl, providerToken, request);

  const newWallet = (initialBalance: MoneyProps, playerId?: string): Promise<TestWallet> =>
    createWalletViaApi(app.baseUrl, operatorToken, {
      initialBalance,
      ...(playerId === undefined ? {} : { playerId }),
    });

  const walletOf = async (walletId: string): Promise<StoredWallet> => {
    const [wallet] = await rows<StoredWallet>(
      'select balance::text as balance, version from wallets where id = $1',
      [walletId],
    );
    if (wallet === undefined) {
      throw new MissingRowError(`wallet ${walletId}`);
    }
    return wallet;
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

  const ledgerLegsOf = (transactionId: string): Promise<Json[]> =>
    rows<Json>(
      `select account_kind, direction, amount::text as amount from ledger_entries
        where transaction_id = $1 order by account_kind desc`,
      [transactionId],
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
    const entry = expected.walletEntry;
    expect(await ledgerLegsOf(transactionId)).toEqual(
      entry === undefined
        ? []
        : [
            { account_kind: 'WALLET', direction: entry.direction, amount: entry.amount },
            { account_kind: 'HOUSE', direction: opposite(entry.direction), amount: entry.amount },
          ],
    );
    expect(await eventTypesOf(transactionId)).toEqual([...events]);
    expect(
      await rows(
        `select http_status, transaction_id, response_body from idempotency_records
          where provider_id = $1 and idempotency_key = $2`,
        [request.body.providerId, request.idempotencyKey],
      ),
    ).toEqual([
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
    events: readonly string[] = defaultEvents(expected),
  ): Promise<string> => {
    const first = await submit(request);
    expect(first.status).toBe(HTTP_STATUS[expected.status]);
    const body = await jsonOf(first);
    const transactionId = transactionIdOf(body);
    expect(body).toEqual(outcomeBody(transactionId, request, expected, false));

    const replay = await submit(request);
    expect(replay.status).toBe(HTTP_STATUS[expected.status]);
    expect(await jsonOf(replay)).toEqual(outcomeBody(transactionId, request, expected, true));

    await expectStored(transactionId, request, expected, events);
    return transactionId;
  };

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

  describe('currency and player context', () => {
    it('rejects a BRL bet on a USD wallet with CURRENCY_MISMATCH and posts nothing', async () => {
      const wallet = await newWallet(usd('100.00'));
      await decide(betCommand({ wallet, amount: '10.00', currency: 'BRL' }), {
        status: 'REJECTED',
        failureCode: FailureCode.CurrencyMismatch,
        balance: usd('100.00'),
      });
      expect(await walletOf(wallet.id)).toEqual({ balance: '100.00', version: 1 });
    });

    it('keeps one wallet per currency for a player and never routes a bet to the other one', async () => {
      const playerId = crypto.randomUUID();
      const brlWallet = await newWallet(brl('50.00'), playerId);
      const usdWallet = await newWallet(usd('70.00'), playerId);
      expect({ ...brlWallet, id: typeof brlWallet.id }).toEqual({
        id: 'string',
        playerId,
        balance: brl('50.00'),
        version: 1,
      });
      expect({ ...usdWallet, id: typeof usdWallet.id }).toEqual({
        id: 'string',
        playerId,
        balance: usd('70.00'),
        version: 1,
      });
      expect(usdWallet.id).not.toBe(brlWallet.id);

      await decide(betCommand({ wallet: brlWallet, amount: '10.00', currency: 'USD' }), {
        status: 'REJECTED',
        failureCode: FailureCode.CurrencyMismatch,
        balance: brl('50.00'),
      });
      expect(await walletOf(brlWallet.id)).toEqual({ balance: '50.00', version: 1 });
      expect(await walletOf(usdWallet.id)).toEqual({ balance: '70.00', version: 1 });
      expect(
        await rows('select count(*)::int as total from wager_transactions where wallet_id = $1', [
          usdWallet.id,
        ]),
      ).toEqual([{ total: 1 }]);
    });

    it('rejects a bet from another player with PLAYER_WALLET_MISMATCH and replays it', async () => {
      const wallet = await newWallet(brl('100.00'));
      await decide(
        betCommand({ wallet: { id: wallet.id, playerId: crypto.randomUUID() }, amount: '10.00' }),
        {
          status: 'REJECTED',
          failureCode: FailureCode.PlayerWalletMismatch,
          balance: brl('100.00'),
        },
      );
      expect(await walletOf(wallet.id)).toEqual({ balance: '100.00', version: 1 });
    });
  });

  describe('reversals without balance', () => {
    it('rejects a rollback of a win already spent with INSUFFICIENT_FUNDS_FOR_REVERSAL', async () => {
      const wallet = await newWallet(brl('0.00'));
      const roundId = `round-${crypto.randomUUID()}`;
      const win = winCommand({ wallet, roundId, amount: '50.00' });
      const winId = await decide(win, {
        status: 'PROCESSED',
        balance: brl('50.00'),
        walletEntry: { direction: 'CREDIT', amount: '50.00' },
      });
      await decide(betCommand({ wallet, amount: '50.00' }), {
        status: 'PROCESSED',
        balance: brl('0.00'),
        walletEntry: { direction: 'DEBIT', amount: '50.00' },
      });

      const rollbackId = await decide(
        rollbackCommand({
          wallet,
          roundId,
          amount: '50.00',
          referenceExternalTransactionId: win.body.externalTransactionId,
        }),
        {
          status: 'REJECTED',
          failureCode: FailureCode.InsufficientFundsForReversal,
          referenceTransactionId: winId,
          balance: brl('0.00'),
        },
      );
      expect(FailureCode.InsufficientFundsForReversal).not.toBe(FailureCode.InsufficientFunds);
      expect(
        await rows(
          `select payload->'data'->>'failureCode' as failure_code from outbox_messages
            where event_type = 'WagerTransactionRejected' and payload->'data'->>'transactionId' = $1`,
          [rollbackId],
        ),
      ).toEqual([{ failure_code: FailureCode.InsufficientFundsForReversal }]);
      expect(await walletOf(wallet.id)).toEqual({ balance: '0.00', version: 3 });
    });

    it('rejects a rollback of a refund without balance with INSUFFICIENT_FUNDS_FOR_REVERSAL', async () => {
      const wallet = await newWallet(brl('100.00'));
      const roundId = `round-${crypto.randomUUID()}`;
      const bet = betCommand({ wallet, roundId, amount: '100.00' });
      const betId = await decide(bet, {
        status: 'PROCESSED',
        balance: brl('0.00'),
        walletEntry: { direction: 'DEBIT', amount: '100.00' },
      });
      const refund = refundCommand({
        wallet,
        roundId,
        amount: '100.00',
        referenceExternalTransactionId: bet.body.externalTransactionId,
      });
      const refundId = await decide(refund, {
        status: 'PROCESSED',
        referenceTransactionId: betId,
        balance: brl('100.00'),
        walletEntry: { direction: 'CREDIT', amount: '100.00' },
      });
      await decide(betCommand({ wallet, amount: '100.00' }), {
        status: 'PROCESSED',
        balance: brl('0.00'),
        walletEntry: { direction: 'DEBIT', amount: '100.00' },
      });

      await decide(
        rollbackCommand({
          wallet,
          roundId,
          amount: '100.00',
          referenceExternalTransactionId: refund.body.externalTransactionId,
        }),
        {
          status: 'REJECTED',
          failureCode: FailureCode.InsufficientFundsForReversal,
          referenceTransactionId: refundId,
          balance: brl('0.00'),
        },
      );
      expect(await walletOf(wallet.id)).toEqual({ balance: '0.00', version: 4 });
    });
  });

  describe('balance limit', () => {
    it('rejects a win of 0.01 on a full wallet with BALANCE_LIMIT_EXCEEDED', async () => {
      const wallet = await newWallet(brl(MAX_BALANCE));
      await decide(winCommand({ wallet, amount: '0.01' }), {
        status: 'REJECTED',
        failureCode: FailureCode.BalanceLimitExceeded,
        balance: brl(MAX_BALANCE),
      });
      expect(await walletOf(wallet.id)).toEqual({ balance: MAX_BALANCE, version: 1 });
    });

    const fillAfterBet = async (
      wallet: TestWallet,
      roundId: string,
    ): Promise<{ bet: WagerTransactionRequest; betId: string }> => {
      const bet = betCommand({ wallet, roundId, amount: '1.00' });
      const betId = await decide(bet, {
        status: 'PROCESSED',
        balance: brl('0.00'),
        walletEntry: { direction: 'DEBIT', amount: '1.00' },
      });
      await decide(winCommand({ wallet, amount: MAX_BALANCE }), {
        status: 'PROCESSED',
        balance: brl(MAX_BALANCE),
        walletEntry: { direction: 'CREDIT', amount: MAX_BALANCE },
      });
      return { bet, betId };
    };

    it('rejects a refund that would overflow the wallet with BALANCE_LIMIT_EXCEEDED', async () => {
      const wallet = await newWallet(brl('1.00'));
      const roundId = `round-${crypto.randomUUID()}`;
      const { bet, betId } = await fillAfterBet(wallet, roundId);
      await decide(
        refundCommand({
          wallet,
          roundId,
          amount: '1.00',
          referenceExternalTransactionId: bet.body.externalTransactionId,
        }),
        {
          status: 'REJECTED',
          failureCode: FailureCode.BalanceLimitExceeded,
          referenceTransactionId: betId,
          balance: brl(MAX_BALANCE),
        },
      );
      expect(await walletOf(wallet.id)).toEqual({ balance: MAX_BALANCE, version: 3 });
    });

    it('rejects a rollback of a bet that would overflow the wallet with BALANCE_LIMIT_EXCEEDED', async () => {
      const wallet = await newWallet(brl('1.00'));
      const roundId = `round-${crypto.randomUUID()}`;
      const { bet, betId } = await fillAfterBet(wallet, roundId);
      await decide(
        rollbackCommand({
          wallet,
          roundId,
          amount: '1.00',
          referenceExternalTransactionId: bet.body.externalTransactionId,
        }),
        {
          status: 'REJECTED',
          failureCode: FailureCode.BalanceLimitExceeded,
          referenceTransactionId: betId,
          balance: brl(MAX_BALANCE),
        },
      );
      expect(await walletOf(wallet.id)).toEqual({ balance: MAX_BALANCE, version: 3 });
    });

    const betFromFull = async (
      amount: string,
      remaining: string,
    ): Promise<{
      wallet: TestWallet;
      roundId: string;
      bet: WagerTransactionRequest;
      betId: string;
    }> => {
      const wallet = await newWallet(brl(MAX_BALANCE));
      const roundId = `round-${crypto.randomUUID()}`;
      const bet = betCommand({ wallet, roundId, amount });
      const betId = await decide(bet, {
        status: 'PROCESSED',
        balance: brl(remaining),
        walletEntry: { direction: 'DEBIT', amount },
      });
      expect(await walletOf(wallet.id)).toEqual({ balance: remaining, version: 2 });
      return { wallet, roundId, bet, betId };
    };

    it('debits a bet of 1.00 from a full wallet and refunds it back to the limit', async () => {
      const { wallet, roundId, bet, betId } = await betFromFull('1.00', '999999999999999998.99');
      await decide(
        refundCommand({
          wallet,
          roundId,
          amount: '1.00',
          referenceExternalTransactionId: bet.body.externalTransactionId,
        }),
        {
          status: 'PROCESSED',
          referenceTransactionId: betId,
          balance: brl(MAX_BALANCE),
          walletEntry: { direction: 'CREDIT', amount: '1.00' },
        },
      );
      expect(await walletOf(wallet.id)).toEqual({ balance: MAX_BALANCE, version: 3 });
    });

    it('debits a bet of 0.01 from a full wallet and rolls it back to the limit', async () => {
      const { wallet, roundId, bet, betId } = await betFromFull('0.01', '999999999999999999.98');
      await decide(
        rollbackCommand({
          wallet,
          roundId,
          amount: '0.01',
          referenceExternalTransactionId: bet.body.externalTransactionId,
        }),
        {
          status: 'PROCESSED',
          referenceTransactionId: betId,
          balance: brl(MAX_BALANCE),
          walletEntry: { direction: 'CREDIT', amount: '0.01' },
        },
      );
      expect(await walletOf(wallet.id)).toEqual({ balance: MAX_BALANCE, version: 3 });
    });
  });

  describe('loss and win', () => {
    it('processes a loss larger than the balance without a ledger entry or balance event', async () => {
      const wallet = await newWallet(brl('100.00'));
      await decide(
        lossCommand({ wallet, amount: '500.00' }),
        { status: 'PROCESSED', balance: brl('100.00') },
        PROCESSED_WITHOUT_MOVEMENT,
      );
      expect(await walletOf(wallet.id)).toEqual({ balance: '100.00', version: 1 });
    });

    it('rejects a loss that references a bet of another round with REFERENCE_MISMATCH', async () => {
      const wallet = await newWallet(brl('100.00'));
      const bet = betCommand({ wallet, amount: '10.00' });
      const betId = await decide(bet, {
        status: 'PROCESSED',
        balance: brl('90.00'),
        walletEntry: { direction: 'DEBIT', amount: '10.00' },
      });
      await decide(
        lossCommand({
          wallet,
          amount: '10.00',
          roundId: `round-${crypto.randomUUID()}`,
          referenceExternalTransactionId: bet.body.externalTransactionId,
        }),
        {
          status: 'REJECTED',
          failureCode: FailureCode.ReferenceMismatch,
          referenceTransactionId: betId,
          balance: brl('90.00'),
        },
      );
      expect(await walletOf(wallet.id)).toEqual({ balance: '90.00', version: 2 });
    });

    it('credits a win larger than the referenced bet', async () => {
      const wallet = await newWallet(brl('100.00'));
      const roundId = `round-${crypto.randomUUID()}`;
      const bet = betCommand({ wallet, roundId, amount: '10.00' });
      const betId = await decide(bet, {
        status: 'PROCESSED',
        balance: brl('90.00'),
        walletEntry: { direction: 'DEBIT', amount: '10.00' },
      });
      await decide(
        winCommand({
          wallet,
          roundId,
          amount: '250.00',
          referenceExternalTransactionId: bet.body.externalTransactionId,
        }),
        {
          status: 'PROCESSED',
          referenceTransactionId: betId,
          balance: brl('340.00'),
          walletEntry: { direction: 'CREDIT', amount: '250.00' },
        },
      );
      expect(await walletOf(wallet.id)).toEqual({ balance: '340.00', version: 3 });
    });

    it('processes a win without a reference', async () => {
      const wallet = await newWallet(brl('100.00'));
      await decide(winCommand({ wallet, amount: '15.00' }), {
        status: 'PROCESSED',
        balance: brl('115.00'),
        walletEntry: { direction: 'CREDIT', amount: '15.00' },
      });
      expect(await walletOf(wallet.id)).toEqual({ balance: '115.00', version: 2 });
    });
  });

  describe('wallet version', () => {
    it('starts at 1 with and without an initial balance', async () => {
      const empty = await newWallet(brl('0.00'));
      const funded = await newWallet(brl('100.00'));
      expect(empty.version).toBe(1);
      expect(funded.version).toBe(1);
      expect(await walletOf(empty.id)).toEqual({ balance: '0.00', version: 1 });
      expect(await walletOf(funded.id)).toEqual({ balance: '100.00', version: 1 });
      expect(
        await rows(
          'select wallet_id, wallet_version from wallet_ledger_entries where wallet_id in ($1, $2)',
          [empty.id, funded.id],
        ),
      ).toEqual([{ wallet_id: funded.id, wallet_version: 1 }]);
    });

    it('does not change on loss, rejection, pending reference, replay, conflicts or a missing wallet', async () => {
      const wallet = await newWallet(brl('100.00'));
      const unchanged = { balance: '100.00', version: 1 };

      const loss = lossCommand({ wallet, amount: '5.00' });
      await decide(loss, { status: 'PROCESSED', balance: brl('100.00') });
      expect(await walletOf(wallet.id)).toEqual(unchanged);

      const bet = betCommand({ wallet, amount: '500.00' });
      await decide(bet, {
        status: 'REJECTED',
        failureCode: FailureCode.InsufficientFunds,
        balance: brl('100.00'),
      });
      expect(await walletOf(wallet.id)).toEqual(unchanged);

      await decide(
        refundCommand({
          wallet,
          referenceExternalTransactionId: `ext-missing-${crypto.randomUUID()}`,
        }),
        { status: 'PENDING_REFERENCE', balance: brl('100.00') },
      );
      expect(await walletOf(wallet.id)).toEqual(unchanged);

      const keyConflict = await submit({
        ...loss,
        body: { ...loss.body, money: brl('6.00') },
      });
      expect(keyConflict.status).toBe(409);
      expect(await jsonOf(keyConflict)).toMatchObject({
        failureCode: FailureCode.IdempotencyKeyConflict,
      });
      const externalConflict = await submit({
        ...bet,
        idempotencyKey: `idem-${crypto.randomUUID()}`,
      });
      expect(externalConflict.status).toBe(409);
      expect(await jsonOf(externalConflict)).toMatchObject({
        failureCode: FailureCode.ExternalTransactionIdConflict,
      });
      expect(await walletOf(wallet.id)).toEqual(unchanged);

      const missing = await submit(
        betCommand({ wallet: { id: crypto.randomUUID(), playerId: wallet.playerId } }),
      );
      expect(missing.status).toBe(422);
      expect(await jsonOf(missing)).toMatchObject({
        transactionId: null,
        failureCode: FailureCode.WalletNotFound,
      });
      expect(await walletOf(wallet.id)).toEqual(unchanged);
      expect(
        await rows(
          'select count(*)::int as total from wallet_ledger_entries where wallet_id = $1',
          [wallet.id],
        ),
      ).toEqual([{ total: 1 }]);
    });

    it('increments by one on each balance movement', async () => {
      const wallet = await newWallet(brl('100.00'));
      const roundId = `round-${crypto.randomUUID()}`;
      const bet = betCommand({ wallet, roundId, amount: '30.00' });
      const betId = await decide(bet, {
        status: 'PROCESSED',
        balance: brl('70.00'),
        walletEntry: { direction: 'DEBIT', amount: '30.00' },
      });
      expect(await walletOf(wallet.id)).toEqual({ balance: '70.00', version: 2 });

      const winId = await decide(winCommand({ wallet, roundId, amount: '20.00' }), {
        status: 'PROCESSED',
        balance: brl('90.00'),
        walletEntry: { direction: 'CREDIT', amount: '20.00' },
      });
      expect(await walletOf(wallet.id)).toEqual({ balance: '90.00', version: 3 });

      const refundId = await decide(
        refundCommand({
          wallet,
          roundId,
          amount: '30.00',
          referenceExternalTransactionId: bet.body.externalTransactionId,
        }),
        {
          status: 'PROCESSED',
          referenceTransactionId: betId,
          balance: brl('120.00'),
          walletEntry: { direction: 'CREDIT', amount: '30.00' },
        },
      );
      expect(await walletOf(wallet.id)).toEqual({ balance: '120.00', version: 4 });
      expect(
        await rows(
          `select transaction_id, wallet_version from wallet_ledger_entries
            where wallet_id = $1 and wallet_version > 1 order by wallet_version`,
          [wallet.id],
        ),
      ).toEqual([
        { transaction_id: betId, wallet_version: 2 },
        { transaction_id: winId, wallet_version: 3 },
        { transaction_id: refundId, wallet_version: 4 },
      ]);
      expect(
        await rows(
          `select payload->'data'->>'transactionId' as transaction_id,
                  (payload->'data'->>'walletVersion')::int as wallet_version
             from outbox_messages
            where event_type = 'WalletBalanceChanged' and aggregate_id = $1
              and (payload->'data'->>'walletVersion')::int > 1
            order by wallet_version`,
          [wallet.id],
        ),
      ).toEqual([
        { transaction_id: betId, wallet_version: 2 },
        { transaction_id: winId, wallet_version: 3 },
        { transaction_id: refundId, wallet_version: 4 },
      ]);
    });
  });

  describe('outbox events by outcome', () => {
    it('writes only Rejected, only PendingReference, or Processed with BalanceChanged', async () => {
      const wallet = await newWallet(brl('100.00'));
      const rejectedId = await decide(
        betCommand({ wallet, amount: '500.00' }),
        { status: 'REJECTED', failureCode: FailureCode.InsufficientFunds, balance: brl('100.00') },
        ['WagerTransactionRejected'],
      );
      const pendingId = await decide(
        rollbackCommand({
          wallet,
          referenceExternalTransactionId: `ext-missing-${crypto.randomUUID()}`,
        }),
        { status: 'PENDING_REFERENCE', balance: brl('100.00') },
        ['WagerTransactionPendingReference'],
      );
      const processedId = await decide(
        betCommand({ wallet, amount: '40.00' }),
        {
          status: 'PROCESSED',
          balance: brl('60.00'),
          walletEntry: { direction: 'DEBIT', amount: '40.00' },
        },
        ['WagerTransactionProcessed', 'WalletBalanceChanged'],
      );
      expect(
        await rows(
          `select payload->'data'->>'transactionId' as transaction_id, event_type
             from outbox_messages
            where payload->'data'->>'transactionId' in ($1, $2, $3)
            order by event_type`,
          [rejectedId, pendingId, processedId],
        ),
      ).toEqual([
        { transaction_id: pendingId, event_type: 'WagerTransactionPendingReference' },
        { transaction_id: processedId, event_type: 'WagerTransactionProcessed' },
        { transaction_id: rejectedId, event_type: 'WagerTransactionRejected' },
        { transaction_id: processedId, event_type: 'WalletBalanceChanged' },
      ]);
      expect(
        await rows(
          'select transaction_id from pending_reference_retries where transaction_id = $1',
          [pendingId],
        ),
      ).toEqual([{ transaction_id: pendingId }]);
    });
  });

  describe('documented interpretations', () => {
    it('adopts PROCESSED for a loss that references a bet already refunded', async () => {
      const wallet = await newWallet(brl('100.00'));
      const roundId = `round-${crypto.randomUUID()}`;
      const bet = betCommand({ wallet, roundId, amount: '25.00' });
      const betId = await decide(bet, {
        status: 'PROCESSED',
        balance: brl('75.00'),
        walletEntry: { direction: 'DEBIT', amount: '25.00' },
      });
      await decide(
        refundCommand({
          wallet,
          roundId,
          amount: '25.00',
          referenceExternalTransactionId: bet.body.externalTransactionId,
        }),
        {
          status: 'PROCESSED',
          referenceTransactionId: betId,
          balance: brl('100.00'),
          walletEntry: { direction: 'CREDIT', amount: '25.00' },
        },
      );
      await decide(
        lossCommand({
          wallet,
          roundId,
          amount: '25.00',
          referenceExternalTransactionId: bet.body.externalTransactionId,
        }),
        { status: 'PROCESSED', referenceTransactionId: betId, balance: brl('100.00') },
      );
      expect(await walletOf(wallet.id)).toEqual({ balance: '100.00', version: 3 });
    });

    it('adopts REFERENCE_ALREADY_REVERSED for a win and a new refund after the refund was rolled back', async () => {
      const wallet = await newWallet(brl('100.00'));
      const roundId = `round-${crypto.randomUUID()}`;
      const bet = betCommand({ wallet, roundId, amount: '30.00' });
      const betId = await decide(bet, {
        status: 'PROCESSED',
        balance: brl('70.00'),
        walletEntry: { direction: 'DEBIT', amount: '30.00' },
      });
      const refund = refundCommand({
        wallet,
        roundId,
        amount: '30.00',
        referenceExternalTransactionId: bet.body.externalTransactionId,
      });
      const refundId = await decide(refund, {
        status: 'PROCESSED',
        referenceTransactionId: betId,
        balance: brl('100.00'),
        walletEntry: { direction: 'CREDIT', amount: '30.00' },
      });
      await decide(
        rollbackCommand({
          wallet,
          roundId,
          amount: '30.00',
          referenceExternalTransactionId: refund.body.externalTransactionId,
        }),
        {
          status: 'PROCESSED',
          referenceTransactionId: refundId,
          balance: brl('70.00'),
          walletEntry: { direction: 'DEBIT', amount: '30.00' },
        },
      );

      await decide(
        winCommand({
          wallet,
          roundId,
          amount: '60.00',
          referenceExternalTransactionId: bet.body.externalTransactionId,
        }),
        {
          status: 'REJECTED',
          failureCode: FailureCode.ReferenceAlreadyReversed,
          referenceTransactionId: betId,
          balance: brl('70.00'),
        },
      );
      await decide(
        refundCommand({
          wallet,
          roundId,
          amount: '30.00',
          referenceExternalTransactionId: bet.body.externalTransactionId,
        }),
        {
          status: 'REJECTED',
          failureCode: FailureCode.ReferenceAlreadyReversed,
          referenceTransactionId: betId,
          balance: brl('70.00'),
        },
      );
      expect(await walletOf(wallet.id)).toEqual({ balance: '70.00', version: 4 });
    });

    it('adopts crediting both wins that reference the same bet', async () => {
      const wallet = await newWallet(brl('100.00'));
      const roundId = `round-${crypto.randomUUID()}`;
      const bet = betCommand({ wallet, roundId, amount: '10.00' });
      const betId = await decide(bet, {
        status: 'PROCESSED',
        balance: brl('90.00'),
        walletEntry: { direction: 'DEBIT', amount: '10.00' },
      });
      const winOf = (amount: string): WagerTransactionRequest =>
        winCommand({
          wallet,
          roundId,
          amount,
          referenceExternalTransactionId: bet.body.externalTransactionId,
        });
      await decide(winOf('20.00'), {
        status: 'PROCESSED',
        referenceTransactionId: betId,
        balance: brl('110.00'),
        walletEntry: { direction: 'CREDIT', amount: '20.00' },
      });
      await decide(winOf('5.00'), {
        status: 'PROCESSED',
        referenceTransactionId: betId,
        balance: brl('115.00'),
        walletEntry: { direction: 'CREDIT', amount: '5.00' },
      });
      expect(await walletOf(wallet.id)).toEqual({ balance: '115.00', version: 4 });
    });
  });
});
