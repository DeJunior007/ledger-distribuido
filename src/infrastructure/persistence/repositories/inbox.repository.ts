import type { EntityManager } from '@mikro-orm/postgresql';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import type { InboxRepositoryPort } from '@application/ports/repositories/inbox-repository.port';
import type { InboxMessage } from '@domain/messaging/inbox-message';
import * as inboxMessageMapper from '../mappers/inbox-message.mapper';
import { InboxMessageRecord } from '../records/inbox-messages.record';
import { insertedInboxMessageRowsSchema } from '../rows/inbox-message.row';

const INSERT_INBOX_MESSAGE = `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT (consumer_name, message_id) DO NOTHING
RETURNING message_id`;

const MARK_INBOX_MESSAGE_PROCESSED = `UPDATE inbox_messages SET processed_at = ? WHERE consumer_name = ? AND message_id = ?`;

export class MikroOrmInboxRepository implements InboxRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(
      InboxMessageRecord,
      { consumerName, messageId },
      { refresh: true },
    );
    return record === null ? undefined : inboxMessageMapper.toDomain(record);
  }

  async tryInsert(message: InboxMessage): Promise<boolean> {
    const rows: unknown = await this.em.execute(INSERT_INBOX_MESSAGE, [
      message.consumerName,
      message.messageId,
      message.payloadHash,
      message.receivedAt,
      message.processedAt ?? null,
    ]);
    return insertedInboxMessageRowsSchema.parse(rows).length > 0;
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    const processedAt = message.processedAt;
    if (processedAt === undefined) {
      throw new TechnicalError(ErrorClass.Deterministic, 'deterministic');
    }
    await this.em.execute(MARK_INBOX_MESSAGE_PROCESSED, [
      processedAt,
      message.consumerName,
      message.messageId,
    ]);
  }
}
