import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import type { Message, MessageAttributeValue, SQSClient } from '@aws-sdk/client-sqs';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import type { AppConfig } from '@infrastructure/config/env.schema';
import { loadConfig } from '@infrastructure/config/env.schema';
import { createSqsClients, destroySqsClients } from '@infrastructure/messaging/sqs.client';
import type { SqsClientConfig, SqsClients } from '@infrastructure/messaging/sqs.client';
import {
  DLQ_ATTRIBUTE_NAMES,
  DLQ_REASON_ATTRIBUTE,
  DlqReason,
  ORIGINAL_MESSAGE_ID_ATTRIBUTE,
} from '@interfaces/sqs/dlq-mover';
import { readEnvelopeMessageId } from '@interfaces/sqs/message-envelope.schema';

export const REDRIVE_BATCH_SIZE = 10;
export const REDRIVE_VISIBILITY_TIMEOUT_SECONDS = 120;
export const FORCE_FLAG = '--force';

export const TERMINAL_DLQ_REASONS: readonly string[] = [
  DlqReason.ProcessingFailed,
  DlqReason.IdempotencyKeyConflict,
  DlqReason.ExternalTransactionIdConflict,
  DlqReason.InboxPayloadMismatch,
  DlqReason.InvalidPayload,
];

export { DLQ_ATTRIBUTE_NAMES };

export type DlqRedriveConfig = SqsClientConfig &
  Pick<AppConfig, 'WAGER_QUEUE_NAME' | 'WAGER_DLQ_NAME'>;

export interface DlqRedriveOptions {
  readonly force: boolean;
}

export interface DlqRedriveSummary {
  readonly redriven: number;
  readonly skipped: Readonly<Record<string, number>>;
  readonly errors: number;
  readonly reappeared?: number;
}

interface RedriveTarget {
  readonly clients: SqsClients;
  readonly queueUrl: string;
  readonly dlqUrl: string;
  readonly waitSeconds: number;
  readonly force: boolean;
}

interface RedriveTally {
  redriven: number;
  errors: number;
  readonly skipped: Record<string, number>;
  readonly redrivenIds: Set<string>;
}

type MessageAttributes = Record<string, MessageAttributeValue>;

const requireValue = (value: string | undefined, description: string): string => {
  if (value === undefined) {
    throw new TechnicalError(ErrorClass.Permanent, 'queue_permanent', {
      cause: new TypeError(`SQS response without ${description}`),
    });
  }
  return value;
};

const describeFailure = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return 'unknown error';
  }
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' ? `${error.name} (${code})` : error.name;
};

const queueUrlOf = async (client: SQSClient, queueName: string): Promise<string> => {
  const found = await client.send(new GetQueueUrlCommand({ QueueName: queueName }));
  return requireValue(found.QueueUrl, `QueueUrl for ${queueName}`);
};

const countAttribute = (value: string | undefined): number => {
  const parsed = Number(value ?? '0');
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
};

const initialBacklog = async (client: SQSClient, dlqUrl: string): Promise<number> => {
  const result = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlqUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return (
    countAttribute(result.Attributes?.ApproximateNumberOfMessages) +
    countAttribute(result.Attributes?.ApproximateNumberOfMessagesNotVisible)
  );
};

const receiveBatch = async (target: RedriveTarget): Promise<Message[]> => {
  const result = await target.clients.receive.send(
    new ReceiveMessageCommand({
      QueueUrl: target.dlqUrl,
      MaxNumberOfMessages: REDRIVE_BATCH_SIZE,
      VisibilityTimeout: REDRIVE_VISIBILITY_TIMEOUT_SECONDS,
      WaitTimeSeconds: target.waitSeconds,
      MessageAttributeNames: ['All'],
      MessageSystemAttributeNames: ['MessageGroupId'],
    }),
  );
  return result.Messages ?? [];
};

const copyAttribute = (value: MessageAttributeValue): MessageAttributeValue => {
  if (value.DataType === undefined) {
    throw new TechnicalError(ErrorClass.Permanent, 'queue_permanent', {
      cause: new TypeError('message attribute without DataType'),
    });
  }
  return {
    DataType: value.DataType,
    ...(value.StringValue === undefined ? {} : { StringValue: value.StringValue }),
    ...(value.BinaryValue === undefined ? {} : { BinaryValue: value.BinaryValue }),
  };
};

const attributesWithout = (
  message: Message,
  excluded: readonly string[],
): MessageAttributes | undefined => {
  const entries = Object.entries(message.MessageAttributes ?? {})
    .filter(([name]) => !excluded.includes(name))
    .map(([name, value]): [string, MessageAttributeValue] => [name, copyAttribute(value)]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const sendCopy = async (
  client: SQSClient,
  queueUrl: string,
  message: Message,
  attributes: MessageAttributes | undefined,
): Promise<string> => {
  const result = await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: requireValue(message.Body, 'message Body'),
      MessageGroupId: requireValue(message.Attributes?.MessageGroupId, 'MessageGroupId'),
      MessageDeduplicationId: Bun.randomUUIDv7(),
      ...(attributes === undefined ? {} : { MessageAttributes: attributes }),
    }),
  );
  return requireValue(result.MessageId, 'MessageId of the copy');
};

const deleteMessage = async (target: RedriveTarget, message: Message): Promise<void> => {
  await target.clients.default.send(
    new DeleteMessageCommand({
      QueueUrl: target.dlqUrl,
      ReceiptHandle: requireValue(message.ReceiptHandle, 'ReceiptHandle'),
    }),
  );
};

const releaseMessage = async (target: RedriveTarget, message: Message): Promise<void> => {
  if (message.ReceiptHandle === undefined) {
    return;
  }
  try {
    await target.clients.default.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: target.dlqUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: 0,
      }),
    );
  } catch (error) {
    console.error(`release of ${message.MessageId ?? 'unknown'} failed: ${describeFailure(error)}`);
  }
};

const logicalIdOf = (message: Message): string | undefined =>
  message.MessageAttributes?.[ORIGINAL_MESSAGE_ID_ATTRIBUTE]?.StringValue ??
  readEnvelopeMessageId(message.Body) ??
  message.MessageId;

const terminalReasonOf = (message: Message): string | undefined => {
  const reason = message.MessageAttributes?.[DLQ_REASON_ATTRIBUTE]?.StringValue;
  return reason !== undefined && TERMINAL_DLQ_REASONS.includes(reason) ? reason : undefined;
};

const handleMessage = async (
  target: RedriveTarget,
  message: Message,
  tally: RedriveTally,
  seen: Set<string>,
): Promise<void> => {
  const terminalReason = terminalReasonOf(message);
  if (terminalReason !== undefined && !target.force) {
    const copyId = await sendCopy(
      target.clients.default,
      target.dlqUrl,
      message,
      attributesWithout(message, []),
    );
    seen.add(copyId);
    await deleteMessage(target, message);
    tally.skipped[terminalReason] = (tally.skipped[terminalReason] ?? 0) + 1;
    return;
  }
  await sendCopy(
    target.clients.default,
    target.queueUrl,
    message,
    attributesWithout(message, DLQ_ATTRIBUTE_NAMES),
  );
  await deleteMessage(target, message);
  tally.redriven += 1;
  const logicalId = logicalIdOf(message);
  if (logicalId !== undefined) {
    tally.redrivenIds.add(logicalId);
  }
};

const handleBatch = async (
  target: RedriveTarget,
  batch: readonly Message[],
  tally: RedriveTally,
  seen: Set<string>,
): Promise<void> => {
  const blockedGroups = new Set<string>();
  for (const message of batch) {
    const groupId = message.Attributes?.MessageGroupId ?? '';
    if (blockedGroups.has(groupId)) {
      await releaseMessage(target, message);
      continue;
    }
    try {
      await handleMessage(target, message, tally, seen);
    } catch (error) {
      tally.errors += 1;
      blockedGroups.add(groupId);
      console.error(
        `redrive of ${message.MessageId ?? 'unknown'} failed: ${describeFailure(error)}`,
      );
      await releaseMessage(target, message);
    }
  }
};

const isSeen = (message: Message, seen: ReadonlySet<string>): boolean => {
  const logicalId = logicalIdOf(message);
  return (
    (message.MessageId !== undefined && seen.has(message.MessageId)) ||
    (logicalId !== undefined && seen.has(logicalId))
  );
};

const remember = (message: Message, seen: Set<string>): void => {
  for (const id of [message.MessageId, logicalIdOf(message)]) {
    if (id !== undefined) {
      seen.add(id);
    }
  }
};

const drain = async (target: RedriveTarget, backlog: number): Promise<DlqRedriveSummary> => {
  const tally: RedriveTally = {
    redriven: 0,
    errors: 0,
    skipped: {},
    redrivenIds: new Set<string>(),
  };
  const seen = new Set<string>();
  const reappearedIds = new Set<string>();
  let handled = 0;
  while (handled < backlog) {
    const batch = await receiveBatch(target);
    if (batch.length === 0) {
      break;
    }
    const repeated = batch.filter((message) => isSeen(message, seen));
    const fresh = batch
      .filter((message) => !isSeen(message, seen))
      .slice(0, Math.max(backlog - handled, 0));
    const overflow = batch.filter(
      (message) => !repeated.includes(message) && !fresh.includes(message),
    );
    for (const message of fresh) {
      remember(message, seen);
    }
    await handleBatch(target, fresh, tally, seen);
    for (const message of repeated) {
      const logicalId = logicalIdOf(message);
      if (logicalId !== undefined && tally.redrivenIds.has(logicalId)) {
        reappearedIds.add(logicalId);
      }
    }
    handled += fresh.length;
    await Promise.all([...repeated, ...overflow].map((message) => releaseMessage(target, message)));
    if (fresh.length === 0) {
      break;
    }
  }
  return {
    redriven: tally.redriven,
    skipped: tally.skipped,
    errors: tally.errors,
    ...(reappearedIds.size > 0 ? { reappeared: reappearedIds.size } : {}),
  };
};

export const redriveDlq = async (
  config: DlqRedriveConfig,
  options: DlqRedriveOptions,
): Promise<DlqRedriveSummary> => {
  const clients = createSqsClients(config);
  try {
    const queueUrl = await queueUrlOf(clients.default, config.WAGER_QUEUE_NAME);
    const dlqUrl = await queueUrlOf(clients.default, config.WAGER_DLQ_NAME);
    const backlog = await initialBacklog(clients.default, dlqUrl);
    return await drain(
      {
        clients,
        queueUrl,
        dlqUrl,
        waitSeconds: config.SQS_RECEIVE_WAIT_SECONDS,
        force: options.force,
      },
      backlog,
    );
  } finally {
    destroySqsClients(clients);
  }
};

export const parseRedriveArgs = (args: readonly string[]): DlqRedriveOptions => ({
  force: args.includes(FORCE_FLAG),
});

export const formatSummary = (summary: DlqRedriveSummary): string => {
  const skipped = Object.entries(summary.skipped)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${reason}=${String(count)}`);
  const skippedTotal = Object.values(summary.skipped).reduce((total, count) => total + count, 0);
  const details = skipped.length > 0 ? ` (${skipped.join(', ')})` : '';
  const reappeared =
    summary.reappeared === undefined ? '' : ` reappeared=${String(summary.reappeared)}`;
  return `dlq redrive: redriven=${String(summary.redriven)} skipped=${String(skippedTotal)}${details} errors=${String(summary.errors)}${reappeared}`;
};

if (import.meta.main) {
  try {
    const summary = await redriveDlq(
      loadConfig(process.env, { role: 'script' }),
      parseRedriveArgs(process.argv.slice(2)),
    );
    console.log(formatSummary(summary));
    process.exitCode = summary.errors > 0 ? 1 : 0;
  } catch (error) {
    console.error(`dlq redrive failed: ${describeFailure(error)}`);
    process.exitCode = 1;
  }
}
