import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  ListQueuesCommand,
} from '@aws-sdk/client-sqs';
import type { QueueAttributeName, SQSClient } from '@aws-sdk/client-sqs';
import { ErrorClass } from '@application/errors/error-class';
import { loadConfig } from '@infrastructure/config/env.schema';
import { QueueNames } from '@infrastructure/messaging/queue-names';
import {
  createSqsClients,
  destroySqsClients,
  receiveRequestTimeoutMs,
} from '@infrastructure/messaging/sqs.client';
import type { SqsClientConfig, SqsClients } from '@infrastructure/messaging/sqs.client';
import { sqsErrorClassifier } from '@infrastructure/messaging/sqs-error-classifier';
import { EVENTS_VISIBILITY_TIMEOUT_SECONDS, initQueues } from '../../../scripts/queues-init';
import type { QueuesInitConfig } from '../../../scripts/queues-init';

const TEST_MAX_RECEIVE_COUNT = 3;
const TEST_VISIBILITY_TIMEOUT_SECONDS = 5;

const sqsEndpoint = (): string => {
  const endpoint = process.env.TEST_SQS_ENDPOINT;
  if (endpoint === undefined || endpoint === '') {
    throw new TypeError('TEST_SQS_ENDPOINT is not set; run with the test preload');
  }
  return endpoint;
};

const clientConfig = (endpoint: string): SqsClientConfig => ({
  SQS_ENDPOINT: endpoint,
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  SQS_REQUEST_TIMEOUT_MS: 5000,
  SQS_RECEIVE_WAIT_SECONDS: 20,
});

const uniqueConfig = (endpoint: string): QueuesInitConfig => {
  const suffix = randomUUID();
  return {
    ...clientConfig(endpoint),
    WAGER_QUEUE_NAME: `wager-transactions-${suffix}.fifo`,
    WAGER_DLQ_NAME: `wager-transactions-dlq-${suffix}.fifo`,
    EVENTS_QUEUE_NAME: `wallet-events-${suffix}.fifo`,
    CONSUMER_VISIBILITY_TIMEOUT_SECONDS: TEST_VISIBILITY_TIMEOUT_SECONDS,
    CONSUMER_MAX_RECEIVE_COUNT: TEST_MAX_RECEIVE_COUNT,
  };
};

const attributesOf = async (
  client: SQSClient,
  queueUrl: string,
): Promise<Partial<Record<QueueAttributeName, string>>> => {
  const result = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['All'] }),
  );
  return result.Attributes ?? {};
};

const redrivePolicyOf = (attributes: Partial<Record<QueueAttributeName, string>>): unknown =>
  JSON.parse(attributes.RedrivePolicy ?? 'null');

interface BlackHole {
  readonly endpoint: string;
  readonly connections: () => number;
  readonly stop: () => void;
}

const openBlackHole = (): BlackHole => {
  let accepted = 0;
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open: () => {
        accepted += 1;
      },
      data: () => undefined,
    },
  });
  return {
    endpoint: `http://127.0.0.1:${String(server.port)}`,
    connections: () => accepted,
    stop: () => {
      server.stop(true);
    },
  };
};

describe('initQueues', () => {
  let clients: SqsClients;

  beforeAll(() => {
    clients = createSqsClients(clientConfig(sqsEndpoint()));
  });

  afterAll(() => {
    destroySqsClients(clients);
  });

  it('uses the queue names of the closed list as configuration defaults', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://unused' }, { role: 'script' });
    expect(config.WAGER_QUEUE_NAME).toBe(QueueNames.WagerTransactions);
    expect(config.WAGER_DLQ_NAME).toBe(QueueNames.WagerTransactionsDlq);
    expect(config.EVENTS_QUEUE_NAME).toBe(QueueNames.WalletEvents);
  });

  it('creates the three FIFO queues with the redrive policy from the configuration', async () => {
    const config = uniqueConfig(sqsEndpoint());
    const urls = await initQueues(config);

    const dlq = await attributesOf(clients.default, urls.wagerTransactionsDlq);
    expect(dlq.FifoQueue).toBe('true');
    expect(dlq.ContentBasedDeduplication).toBe('false');

    const wager = await attributesOf(clients.default, urls.wagerTransactions);
    expect(wager.FifoQueue).toBe('true');
    expect(wager.ContentBasedDeduplication).toBe('false');
    expect(wager.VisibilityTimeout).toBe(String(TEST_VISIBILITY_TIMEOUT_SECONDS));
    expect(redrivePolicyOf(wager)).toEqual({
      deadLetterTargetArn: dlq.QueueArn,
      maxReceiveCount: config.CONSUMER_MAX_RECEIVE_COUNT,
    });

    const events = await attributesOf(clients.default, urls.walletEvents);
    expect(events.FifoQueue).toBe('true');
    expect(events.ContentBasedDeduplication).toBe('false');
    expect(events.VisibilityTimeout).toBe(String(EVENTS_VISIBILITY_TIMEOUT_SECONDS));
  });

  it('is idempotent when run twice', async () => {
    const config = uniqueConfig(sqsEndpoint());
    const first = await initQueues(config);
    const before = await attributesOf(clients.default, first.wagerTransactions);

    const second = await initQueues(config);
    const after = await attributesOf(clients.default, second.wagerTransactions);

    expect(second).toEqual(first);
    expect(after.VisibilityTimeout).toBe(before.VisibilityTimeout);
    expect(redrivePolicyOf(after)).toEqual(redrivePolicyOf(before));
  });

  it('updates an existing queue whose attributes differ without touching FifoQueue', async () => {
    const config = uniqueConfig(sqsEndpoint());
    const existing = await clients.default.send(
      new CreateQueueCommand({
        QueueName: config.WAGER_QUEUE_NAME,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
          VisibilityTimeout: '60',
        },
      }),
    );

    const urls = await initQueues(config);

    expect(urls.wagerTransactions).toBe(existing.QueueUrl ?? '');
    const wager = await attributesOf(clients.default, urls.wagerTransactions);
    const dlq = await attributesOf(clients.default, urls.wagerTransactionsDlq);
    expect(wager.FifoQueue).toBe('true');
    expect(wager.VisibilityTimeout).toBe(String(TEST_VISIBILITY_TIMEOUT_SECONDS));
    expect(redrivePolicyOf(wager)).toEqual({
      deadLetterTargetArn: dlq.QueueArn,
      maxReceiveCount: TEST_MAX_RECEIVE_COUNT,
    });
  });
});

describe('createSqsClients', () => {
  it('gives the receive client the long poll timeout', () => {
    expect(receiveRequestTimeoutMs(clientConfig(sqsEndpoint()))).toBe(25_000);
  });

  it('fails a request with TimeoutError after requestTimeout, once, instead of hanging', async () => {
    const blackHole = openBlackHole();
    const clients = createSqsClients({
      ...clientConfig(blackHole.endpoint),
      SQS_REQUEST_TIMEOUT_MS: 300,
      SQS_RECEIVE_WAIT_SECONDS: 0,
    });
    try {
      const startedAt = performance.now();
      const failure: unknown = await clients.default.send(new ListQueuesCommand({})).then(
        () => undefined,
        (error: unknown) => error,
      );
      const elapsedMs = performance.now() - startedAt;

      expect(failure).toBeInstanceOf(Error);
      expect(failure instanceof Error ? failure.name : undefined).toBe('TimeoutError');
      expect(elapsedMs).toBeLessThan(3000);
      expect(blackHole.connections()).toBe(1);
      const outcome = sqsErrorClassifier.classify(failure, { shuttingDown: false });
      expect(outcome.kind === 'failure' ? outcome.error.errorClass : undefined).toBe(
        ErrorClass.Connectivity,
      );
    } finally {
      destroySqsClients(clients);
      blackHole.stop();
    }
  });

  it('times out the receive client at its own long poll deadline', async () => {
    const blackHole = openBlackHole();
    const clients = createSqsClients({
      ...clientConfig(blackHole.endpoint),
      SQS_REQUEST_TIMEOUT_MS: 300,
      SQS_RECEIVE_WAIT_SECONDS: 0,
    });
    try {
      const startedAt = performance.now();
      const failure: unknown = await clients.receive.send(new ListQueuesCommand({})).then(
        () => undefined,
        (error: unknown) => error,
      );
      const elapsedMs = performance.now() - startedAt;

      expect(failure instanceof Error ? failure.name : undefined).toBe('TimeoutError');
      expect(elapsedMs).toBeGreaterThanOrEqual(4500);
      expect(elapsedMs).toBeLessThan(8000);
      expect(blackHole.connections()).toBe(1);
    } finally {
      destroySqsClients(clients);
      blackHole.stop();
    }
  });
});
