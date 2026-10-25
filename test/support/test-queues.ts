import { randomUUID } from 'node:crypto';
import type { SqsClientConfig } from '@infrastructure/messaging/sqs.client';
import { initQueues } from '../../scripts/queues-init';
import type { QueueUrls, QueuesInitConfig } from '../../scripts/queues-init';
import { MissingTestEnvironmentError } from './test-database';

export const TEST_VISIBILITY_TIMEOUT_SECONDS = 5;
export const TEST_VISIBILITY_HEARTBEAT_MS = 2000;
export const TEST_MAX_RECEIVE_COUNT = 3;
export const TEST_SQS_REQUEST_TIMEOUT_MS = 5000;
export const TEST_SQS_RECEIVE_WAIT_SECONDS = 1;

export interface TestQueueNames {
  readonly wagerTransactions: string;
  readonly wagerTransactionsDlq: string;
  readonly walletEvents: string;
}

export interface TestQueues {
  readonly suffix: string;
  readonly names: TestQueueNames;
  readonly urls: QueueUrls;
  readonly env: Readonly<Record<string, string>>;
}

export const testSqsEndpoint = (): string => {
  const endpoint = process.env.TEST_SQS_ENDPOINT;
  if (endpoint === undefined || endpoint === '') {
    throw new MissingTestEnvironmentError('TEST_SQS_ENDPOINT');
  }
  return endpoint;
};

export const testSqsClientConfig = (): SqsClientConfig => ({
  SQS_ENDPOINT: testSqsEndpoint(),
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  SQS_REQUEST_TIMEOUT_MS: TEST_SQS_REQUEST_TIMEOUT_MS,
  SQS_RECEIVE_WAIT_SECONDS: TEST_SQS_RECEIVE_WAIT_SECONDS,
});

const queueNamesFor = (suffix: string): TestQueueNames => ({
  wagerTransactions: `wager-transactions-${suffix}.fifo`,
  wagerTransactionsDlq: `wager-transactions-dlq-${suffix}.fifo`,
  walletEvents: `wallet-events-${suffix}.fifo`,
});

export const createTestQueues = async (): Promise<TestQueues> => {
  const suffix = randomUUID();
  const names = queueNamesFor(suffix);
  const clientConfig = testSqsClientConfig();
  const config: QueuesInitConfig = {
    ...clientConfig,
    WAGER_QUEUE_NAME: names.wagerTransactions,
    WAGER_DLQ_NAME: names.wagerTransactionsDlq,
    EVENTS_QUEUE_NAME: names.walletEvents,
    CONSUMER_VISIBILITY_TIMEOUT_SECONDS: TEST_VISIBILITY_TIMEOUT_SECONDS,
    CONSUMER_MAX_RECEIVE_COUNT: TEST_MAX_RECEIVE_COUNT,
  };
  const urls = await initQueues(config);
  const env: Record<string, string> = {
    SQS_ENDPOINT: clientConfig.SQS_ENDPOINT,
    AWS_REGION: clientConfig.AWS_REGION,
    AWS_ACCESS_KEY_ID: clientConfig.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: clientConfig.AWS_SECRET_ACCESS_KEY,
    WAGER_QUEUE_NAME: names.wagerTransactions,
    WAGER_DLQ_NAME: names.wagerTransactionsDlq,
    EVENTS_QUEUE_NAME: names.walletEvents,
    CONSUMER_VISIBILITY_TIMEOUT_SECONDS: String(TEST_VISIBILITY_TIMEOUT_SECONDS),
    CONSUMER_VISIBILITY_HEARTBEAT_MS: String(TEST_VISIBILITY_HEARTBEAT_MS),
    CONSUMER_MAX_RECEIVE_COUNT: String(TEST_MAX_RECEIVE_COUNT),
  };
  return { suffix, names, urls, env };
};
