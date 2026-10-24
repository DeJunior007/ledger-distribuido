import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import type { QueueAttributeName, SQSClient } from '@aws-sdk/client-sqs';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import type { AppConfig } from '@infrastructure/config/env.schema';
import { loadConfig } from '@infrastructure/config/env.schema';
import { createSqsClients, destroySqsClients } from '@infrastructure/messaging/sqs.client';
import type { SqsClientConfig } from '@infrastructure/messaging/sqs.client';

export const EVENTS_VISIBILITY_TIMEOUT_SECONDS = 30;

export type QueuesInitConfig = SqsClientConfig &
  Pick<
    AppConfig,
    | 'WAGER_QUEUE_NAME'
    | 'WAGER_DLQ_NAME'
    | 'EVENTS_QUEUE_NAME'
    | 'CONSUMER_VISIBILITY_TIMEOUT_SECONDS'
    | 'CONSUMER_MAX_RECEIVE_COUNT'
  >;

export interface QueueUrls {
  readonly wagerTransactions: string;
  readonly wagerTransactionsDlq: string;
  readonly walletEvents: string;
}

type QueueAttributes = Partial<Record<QueueAttributeName, string>>;

const QUEUE_NAME_EXISTS = 'QueueNameExists';

const fifoBase: QueueAttributes = { ContentBasedDeduplication: 'false' };

const isQueueNameExists = (error: unknown): boolean =>
  error instanceof Error && error.name === QUEUE_NAME_EXISTS;

const requireValue = (value: string | undefined, description: string): string => {
  if (value === undefined) {
    throw new TechnicalError(ErrorClass.Permanent, 'queue_permanent', {
      cause: new TypeError(`SQS response without ${description}`),
    });
  }
  return value;
};

const ensureQueue = async (
  client: SQSClient,
  queueName: string,
  attributes: QueueAttributes,
): Promise<string> => {
  try {
    const created = await client.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: { FifoQueue: 'true', ...attributes },
      }),
    );
    return requireValue(created.QueueUrl, `QueueUrl for ${queueName}`);
  } catch (error) {
    if (!isQueueNameExists(error)) {
      throw error;
    }
  }
  const found = await client.send(new GetQueueUrlCommand({ QueueName: queueName }));
  const queueUrl = requireValue(found.QueueUrl, `QueueUrl for ${queueName}`);
  await client.send(new SetQueueAttributesCommand({ QueueUrl: queueUrl, Attributes: attributes }));
  return queueUrl;
};

const queueArn = async (client: SQSClient, queueUrl: string): Promise<string> => {
  const result = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
  );
  return requireValue(result.Attributes?.QueueArn, `QueueArn for ${queueUrl}`);
};

export const initQueues = async (config: QueuesInitConfig): Promise<QueueUrls> => {
  const clients = createSqsClients(config);
  try {
    const client = clients.default;
    const wagerTransactionsDlq = await ensureQueue(client, config.WAGER_DLQ_NAME, fifoBase);
    const deadLetterTargetArn = await queueArn(client, wagerTransactionsDlq);
    const wagerTransactions = await ensureQueue(client, config.WAGER_QUEUE_NAME, {
      ...fifoBase,
      VisibilityTimeout: String(config.CONSUMER_VISIBILITY_TIMEOUT_SECONDS),
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn,
        maxReceiveCount: config.CONSUMER_MAX_RECEIVE_COUNT,
      }),
    });
    const walletEvents = await ensureQueue(client, config.EVENTS_QUEUE_NAME, {
      ...fifoBase,
      VisibilityTimeout: String(EVENTS_VISIBILITY_TIMEOUT_SECONDS),
    });
    return { wagerTransactions, wagerTransactionsDlq, walletEvents };
  } finally {
    destroySqsClients(clients);
  }
};

const describeFailure = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return 'unknown error';
  }
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' ? `${error.name} (${code})` : error.name;
};

if (import.meta.main) {
  try {
    const urls = await initQueues(loadConfig(process.env, { role: 'script' }));
    console.log(`queues ready: ${Object.values(urls).join(', ')}`);
  } catch (error) {
    console.error(`queues init failed: ${describeFailure(error)}`);
    process.exitCode = 1;
  }
}
