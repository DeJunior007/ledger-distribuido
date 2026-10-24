import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import { ClockPort } from '@application/ports/clock.port';
import { HasherPort } from '@application/ports/hasher.port';
import { LoggerPort } from '@application/ports/logger.port';
import { MetricsPort } from '@application/ports/metrics.port';
import { UnitOfWorkPort } from '@application/ports/unit-of-work.port';
import { computeRawBodyHash } from '@application/services/payload-hash';
import { InboxMessage } from '@domain/messaging/inbox-message';

export const EVENTS_AUDIT_CONSUMER = 'wallet-events-audit';

export interface RecordAuditedEventCommand {
  eventId: string;
  rawBody: string;
}

export type AuditedEventOutcome = 'recorded' | 'duplicate' | 'payload_mismatch';

export class RecordAuditedEventUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly hasher: HasherPort,
    private readonly clock: ClockPort,
    private readonly metrics: MetricsPort,
    private readonly logger: LoggerPort,
  ) {}

  async execute(command: RecordAuditedEventCommand): Promise<AuditedEventOutcome> {
    const payloadHash = computeRawBodyHash(command.rawBody, this.hasher);
    const outcome = await this.unitOfWork.run(
      'short',
      async (repos): Promise<AuditedEventOutcome> => {
        const now = this.clock.now();
        const message = InboxMessage.receive({
          consumerName: EVENTS_AUDIT_CONSUMER,
          messageId: command.eventId,
          payloadHash,
          now,
        });
        if (await repos.inbox.tryInsert(message)) {
          message.markProcessed(now);
          await repos.inbox.markProcessed(message);
          return 'recorded';
        }
        const existing = await repos.inbox.find(EVENTS_AUDIT_CONSUMER, command.eventId);
        if (existing === undefined) {
          throw new TechnicalError(ErrorClass.Deterministic, 'inbox_without_record');
        }
        return existing.matchesPayload(payloadHash) ? 'duplicate' : 'payload_mismatch';
      },
    );
    if (outcome === 'duplicate') {
      this.metrics.inboxDuplicate(EVENTS_AUDIT_CONSUMER);
    }
    if (outcome === 'payload_mismatch') {
      this.metrics.inboxPayloadMismatch(EVENTS_AUDIT_CONSUMER);
      this.logger.error('audited event redelivered with a different payload', {
        eventId: command.eventId,
      });
    }
    return outcome;
  }
}
