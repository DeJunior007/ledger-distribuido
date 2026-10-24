import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import { IdempotencyRecord } from '@domain/idempotency/idempotency-record';
import type { TransactionResultBody } from '@domain/idempotency/response-bodies';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import { loadConfig } from '@infrastructure/config/env.schema';
import { MikroOrmUnitOfWork } from '@infrastructure/persistence/mikro-orm-unit-of-work';
import { closeOrmInstances, openOrmInstances } from '@infrastructure/persistence/orm-instances';
import type { OrmInstances } from '@infrastructure/persistence/orm-instances';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';

const PROVIDER_ID = 'provider-a';
const IDEMPOTENCY_KEY = 'key-0001';
const PAYLOAD_HASH = 'a'.repeat(64);
const CREATED_AT = new Date('2026-10-24T12:00:00.000Z');
const RESOLVED_AT = new Date('2026-10-24T12:05:00.000Z');

interface StoredRow {
  readonly http_status: number;
  readonly response_body: unknown;
  readonly updated_at: Date;
}

class MissingRowError extends Error {
  constructor() {
    super('idempotency record row was not found');
    this.name = 'MissingRowError';
  }
}

const pendingBody: TransactionResultBody = {
  transactionId: null,
  status: 'PENDING_REFERENCE',
  kind: WagerTransactionKind.Refund,
  balance: { amount: '10.00', currency: 'BRL' },
  idempotentReplay: false,
};

const processedBody: TransactionResultBody = {
  transactionId: null,
  status: 'PROCESSED',
  kind: WagerTransactionKind.Refund,
  balance: { amount: '25.50', currency: 'BRL' },
  idempotentReplay: false,
};

const newRecord = (
  httpStatus: 200 | 202,
  idempotencyKey: string = IDEMPOTENCY_KEY,
): IdempotencyRecord =>
  IdempotencyRecord.create({
    providerId: PROVIDER_ID,
    idempotencyKey,
    payloadHash: PAYLOAD_HASH,
    transactionId: undefined,
    httpStatus,
    responseBody: httpStatus === 202 ? pendingBody : processedBody,
    createdAt: CREATED_AT,
  });

const failureOf = <T>(promise: Promise<T>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );

const withClient = async <T>(url: string, work: (client: Client) => Promise<T>): Promise<T> => {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
};

const storedRow = (database: TestDatabase, idempotencyKey: string): Promise<StoredRow> =>
  withClient(database.appUrl, async (client) => {
    const result = await client.query<StoredRow>(
      `SELECT http_status, response_body, updated_at
       FROM idempotency_records
       WHERE provider_id = $1 AND idempotency_key = $2`,
      [PROVIDER_ID, idempotencyKey],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new MissingRowError();
    }
    return row;
  });

const countRows = (database: TestDatabase): Promise<number> =>
  withClient(database.appUrl, async (client) => {
    const result = await client.query<{ total: number }>(
      'SELECT count(*)::int AS total FROM idempotency_records',
    );
    return result.rows[0]?.total ?? -1;
  });

describe('MikroOrmIdempotencyRepository', () => {
  let database: TestDatabase;
  let instances: OrmInstances;
  let uow: MikroOrmUnitOfWork;

  beforeEach(async () => {
    database = await createTestDatabase();
    const config = loadConfig({ DATABASE_URL: database.appUrl }, { role: 'api' });
    instances = await openOrmInstances(config);
    uow = new MikroOrmUnitOfWork(instances, config);
  });

  afterEach(async () => {
    await closeOrmInstances(instances);
  });

  const insert = (record: IdempotencyRecord): Promise<void> =>
    uow.run('write', (repos) => {
      repos.idempotency.insert(record);
      return Promise.resolve();
    });

  it('inserts a record and finds it again with every field preserved', async () => {
    const record = newRecord(202);
    await insert(record);

    const found = await uow.run('write', (repos) =>
      repos.idempotency.find(PROVIDER_ID, IDEMPOTENCY_KEY),
    );

    expect(found?.toState()).toEqual(record.toState());
  });

  it('finds records outside a transaction and returns undefined for unknown keys', async () => {
    await insert(newRecord(200));

    const [found, missing] = await uow.read(async (repos) => [
      await repos.idempotency.find(PROVIDER_ID, IDEMPOTENCY_KEY),
      await repos.idempotency.find(PROVIDER_ID, 'unknown-key'),
    ]);

    expect(found?.toState().httpStatus).toBe(200);
    expect(found?.toReplay().body).toEqual({ ...processedBody, idempotentReplay: true });
    expect(missing).toBeUndefined();
  });

  it('resolves a 202 record to 200 through update', async () => {
    await insert(newRecord(202));

    await uow.run('write', async (repos) => {
      const record = await repos.idempotency.find(PROVIDER_ID, IDEMPOTENCY_KEY, {
        refresh: true,
      });
      record?.resolve({ httpStatus: 200, responseBody: processedBody, at: RESOLVED_AT });
      if (record !== undefined) {
        repos.idempotency.update(record);
      }
    });

    const row = await storedRow(database, IDEMPOTENCY_KEY);
    expect(row.http_status).toBe(200);
    expect(row.response_body).toEqual(processedBody);
    expect(row.updated_at.toISOString()).toBe(RESOLVED_AT.toISOString());
  });

  it('classifies the JG007 guard on an update of a final record as deterministic', async () => {
    await insert(newRecord(200));

    const failure = await failureOf(
      uow.run('write', async (repos) => {
        const record = await repos.idempotency.find(PROVIDER_ID, IDEMPOTENCY_KEY);
        if (record === undefined) {
          return;
        }
        const tampered = IdempotencyRecord.rehydrate({
          ...record.toState(),
          httpStatus: 500,
          updatedAt: RESOLVED_AT,
        });
        repos.idempotency.update(tampered);
        await repos.flush();
      }),
    );

    expect(failure).toBeInstanceOf(TechnicalError);
    expect(failure).toMatchObject({
      errorClass: ErrorClass.Deterministic,
      reason: 'deterministic',
    });
    expect(Reflect.get(Object(Reflect.get(Object(failure), 'cause')), 'code')).toBe('JG007');
    const row = await storedRow(database, IDEMPOTENCY_KEY);
    expect(row.http_status).toBe(200);
    expect(row.updated_at.toISOString()).toBe(CREATED_AT.toISOString());
  });

  it('refuses to update a record that was not loaded in the same transaction', async () => {
    await insert(newRecord(202));
    const detached = newRecord(202);
    detached.resolve({ httpStatus: 200, responseBody: processedBody, at: RESOLVED_AT });

    const failure = await failureOf(
      uow.run('write', (repos) => {
        repos.idempotency.update(detached);
        return Promise.resolve();
      }),
    );

    expect(failure).toBeInstanceOf(TechnicalError);
    expect(failure).toMatchObject({ errorClass: ErrorClass.Deterministic });
    expect((await storedRow(database, IDEMPOTENCY_KEY)).http_status).toBe(202);
  });

  it('turns a concurrent insert of the same key into a race on the primary key', async () => {
    await insert(newRecord(202));

    const failure = await failureOf(insert(newRecord(200)));

    expect(failure).toBeInstanceOf(TechnicalError);
    expect(failure).toMatchObject({
      errorClass: ErrorClass.Race,
      reason: 'race',
      constraint: 'idempotency_records_pkey',
    });
    expect(await countRows(database)).toBe(1);
  });

  it('rereads the database when refresh is requested', async () => {
    await insert(newRecord(202));

    const [cached, refreshed] = await uow.run('write', async (repos) => {
      await repos.idempotency.find(PROVIDER_ID, IDEMPOTENCY_KEY);
      await withClient(database.appUrl, (client) =>
        client.query(
          `UPDATE idempotency_records
           SET http_status = 200, response_body = $1, updated_at = $2
           WHERE provider_id = $3 AND idempotency_key = $4`,
          [JSON.stringify(processedBody), RESOLVED_AT, PROVIDER_ID, IDEMPOTENCY_KEY],
        ),
      );
      return [
        await repos.idempotency.find(PROVIDER_ID, IDEMPOTENCY_KEY),
        await repos.idempotency.find(PROVIDER_ID, IDEMPOTENCY_KEY, { refresh: true }),
      ];
    });

    expect(cached?.toState().httpStatus).toBe(202);
    expect(refreshed?.toState().httpStatus).toBe(200);
    expect(refreshed?.toState().updatedAt.toISOString()).toBe(RESOLVED_AT.toISOString());
  });
});
