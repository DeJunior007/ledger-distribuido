import { describe, expect, it } from 'bun:test';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import { InboxRepositoryPort } from '@application/ports/repositories/inbox-repository.port';
import {
  UnitOfWorkPort,
  type ReadRepositories,
  type Repositories,
  type TransactionKind,
} from '@application/ports/unit-of-work.port';
import {
  EVENTS_AUDIT_CONSUMER,
  RecordAuditedEventUseCase,
} from '@application/use-cases/record-audited-event.use-case';
import type { InboxMessage } from '@domain/messaging/inbox-message';
import { Sha256Hasher } from '@infrastructure/system/sha256-hasher';
import {
  compositeKey,
  type InMemoryUnitOfWork,
} from '@test/support/fakes/in-memory-unit-of-work.fake';
import { FakeLogger } from '@test/support/fakes/logger.fake';
import { FakeMetrics } from '@test/support/fakes/metrics.fake';
import { FixedClock } from '@test/support/fixed-clock';
import { at, newUnitOfWork, rejection } from './fixtures';

const hasher = new Sha256Hasher();
const body = '{"eventId":"event-1","eventType":"WalletBalanceChanged"}';

const setup = () => {
  const uow = newUnitOfWork();
  const metrics = new FakeMetrics();
  const logger = new FakeLogger();
  const useCase = new RecordAuditedEventUseCase(uow, hasher, new FixedClock(at), metrics, logger);
  const inboxRow = (eventId: string) =>
    uow.database.inbox.get(compositeKey(EVENTS_AUDIT_CONSUMER, eventId));
  return { uow, metrics, logger, useCase, inboxRow };
};

const consumer = { consumer: EVENTS_AUDIT_CONSUMER };

class RefusingInboxRepository extends InboxRepositoryPort {
  find(): Promise<InboxMessage | undefined> {
    return Promise.resolve(undefined);
  }

  tryInsert(): Promise<boolean> {
    return Promise.resolve(false);
  }

  markProcessed(): Promise<void> {
    return Promise.resolve();
  }
}

class RefusingInboxUnitOfWork extends UnitOfWorkPort {
  constructor(private readonly inner: InMemoryUnitOfWork) {
    super();
  }

  run<T>(kind: TransactionKind, work: (repos: Repositories) => Promise<T>): Promise<T> {
    return this.inner.run(kind, (repos) =>
      work({ ...repos, inbox: new RefusingInboxRepository() }),
    );
  }

  read<T>(work: (repos: ReadRepositories) => Promise<T>): Promise<T> {
    return this.inner.read(work);
  }
}

describe('RecordAuditedEventUseCase', () => {
  it('records a new event as processed in the audit inbox', async () => {
    const { useCase, metrics, inboxRow } = setup();

    expect(await useCase.execute({ eventId: 'event-1', rawBody: body })).toBe('recorded');
    expect(inboxRow('event-1')).toStrictEqual({
      consumerName: 'wallet-events-audit',
      messageId: 'event-1',
      payloadHash: hasher.sha256Hex(body),
      receivedAt: at,
      processedAt: at,
    });
    expect(metrics.counter('inbox_duplicates_total', consumer)).toBe(0);
    expect(metrics.counter('inbox_payload_mismatch_total', consumer)).toBe(0);
  });

  it('counts a duplicate when the same event arrives with the same body', async () => {
    const { useCase, metrics, logger } = setup();
    await useCase.execute({ eventId: 'event-1', rawBody: body });

    expect(await useCase.execute({ eventId: 'event-1', rawBody: body })).toBe('duplicate');
    expect(metrics.counter('inbox_duplicates_total', consumer)).toBe(1);
    expect(metrics.counter('inbox_payload_mismatch_total', consumer)).toBe(0);
    expect(logger.entriesAt('error')).toStrictEqual([]);
  });

  it('counts and logs a payload mismatch when the same event arrives with another body', async () => {
    const { useCase, metrics, logger, inboxRow } = setup();
    await useCase.execute({ eventId: 'event-1', rawBody: body });

    expect(await useCase.execute({ eventId: 'event-1', rawBody: `${body} ` })).toBe(
      'payload_mismatch',
    );
    expect(metrics.counter('inbox_payload_mismatch_total', consumer)).toBe(1);
    expect(metrics.counter('inbox_duplicates_total', consumer)).toBe(0);
    expect(logger.entriesAt('error').map((entry) => entry.fields.eventId)).toStrictEqual([
      'event-1',
    ]);
    expect(inboxRow('event-1')?.payloadHash).toBe(hasher.sha256Hex(body));
  });

  it('keeps events with different ids independent', async () => {
    const { useCase, metrics } = setup();

    expect(await useCase.execute({ eventId: 'event-1', rawBody: body })).toBe('recorded');
    expect(await useCase.execute({ eventId: 'event-2', rawBody: body })).toBe('recorded');
    expect(metrics.counter('inbox_duplicates_total', consumer)).toBe(0);
  });

  it('fails deterministically when the insert is refused but no record exists', async () => {
    const { uow, metrics } = setup();
    const refusing = new RecordAuditedEventUseCase(
      new RefusingInboxUnitOfWork(uow),
      hasher,
      new FixedClock(at),
      metrics,
      new FakeLogger(),
    );

    const error = await rejection(refusing.execute({ eventId: 'event-1', rawBody: body }));
    expect(error).toBeInstanceOf(TechnicalError);
    expect(error instanceof TechnicalError ? error.errorClass : undefined).toBe(
      ErrorClass.Deterministic,
    );
  });
});
