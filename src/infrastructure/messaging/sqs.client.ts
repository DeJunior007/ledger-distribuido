import { SQSClient } from '@aws-sdk/client-sqs';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { AppConfig } from '@infrastructure/config/env.schema';

export const SQS_CONNECTION_TIMEOUT_MS = 2000;
export const SQS_MAX_ATTEMPTS = 1;
const RECEIVE_TIMEOUT_MARGIN_SECONDS = 5;

export type SqsClientConfig = Pick<
  AppConfig,
  | 'SQS_ENDPOINT'
  | 'AWS_REGION'
  | 'AWS_ACCESS_KEY_ID'
  | 'AWS_SECRET_ACCESS_KEY'
  | 'SQS_REQUEST_TIMEOUT_MS'
  | 'SQS_RECEIVE_WAIT_SECONDS'
>;

export interface SqsClients {
  readonly receive: SQSClient;
  readonly default: SQSClient;
}

export const receiveRequestTimeoutMs = (config: SqsClientConfig): number =>
  (config.SQS_RECEIVE_WAIT_SECONDS + RECEIVE_TIMEOUT_MARGIN_SECONDS) * 1000;

export const createSqsClient = (config: SqsClientConfig, requestTimeout: number): SQSClient =>
  new SQSClient({
    endpoint: config.SQS_ENDPOINT,
    region: config.AWS_REGION,
    credentials: {
      accessKeyId: config.AWS_ACCESS_KEY_ID,
      secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
    },
    maxAttempts: SQS_MAX_ATTEMPTS,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: SQS_CONNECTION_TIMEOUT_MS,
      requestTimeout,
      throwOnRequestTimeout: true,
    }),
  });

export const createSqsClients = (config: SqsClientConfig): SqsClients => ({
  receive: createSqsClient(config, receiveRequestTimeoutMs(config)),
  default: createSqsClient(config, config.SQS_REQUEST_TIMEOUT_MS),
});

export const destroySqsClients = (clients: SqsClients): void => {
  clients.receive.destroy();
  clients.default.destroy();
};
