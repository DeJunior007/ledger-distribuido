import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import type { SQSClient } from '@aws-sdk/client-sqs';
import {
  buildEnvelope,
  countMessages,
  createTestSqsClient,
  parseEnvelope,
  peekMessages,
  publishBody,
  readDlq,
} from '@test/support/sqs';
import type { ReceivedTestMessage } from '@test/support/sqs';
import { createTestQueues, testSqsClientConfig } from '@test/support/test-queues';
import type { TestQueues } from '@test/support/test-queues';
import { waitFor } from '@test/support/wait-for';
import {
  DLQ_ATTRIBUTE_NAMES,
  FORCE_FLAG,
  TERMINAL_DLQ_REASONS,
  formatSummary,
  parseRedriveArgs,
  redriveDlq,
} from '../../../scripts/dlq-redrive';
import type { DlqRedriveConfig } from '../../../scripts/dlq-redrive';

const QUEUE_WAIT = { timeoutMs: 10_000, intervalMs: 100 } as const;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SCRIPT_PATH = join(import.meta.dir, '../../../scripts/dlq-redrive.ts');
const PROJECT_ROOT = join(import.meta.dir, '../../..');

interface SeededMessage {
  readonly groupId: string;
  readonly deduplicationId: string;
  readonly body: string;
  readonly attributes: Readonly<Record<string, string>>;
}

const redriveConfig = (queues: TestQueues): DlqRedriveConfig => ({
  ...testSqsClientConfig(),
  WAGER_QUEUE_NAME: queues.names.wagerTransactions,
  WAGER_DLQ_NAME: queues.names.wagerTransactionsDlq,
});

const dlqMessage = (
  attributes: Readonly<Record<string, string>>,
  groupId: string = crypto.randomUUID(),
): SeededMessage => {
  const envelope = buildEnvelope({ data: { walletId: groupId } });
  return {
    groupId,
    deduplicationId: `dlq-${crypto.randomUUID()}`,
    body: JSON.stringify(envelope),
    attributes,
  };
};

const terminalMessage = (reason: string): SeededMessage =>
  dlqMessage({
    dlqReason: reason,
    originalMessageId: `orig-${reason}`,
    correlationId: `corr-${reason}`,
  });

const seed = async (
  client: SQSClient,
  queueUrl: string,
  messages: readonly SeededMessage[],
): Promise<void> => {
  for (const message of messages) {
    await publishBody(client, queueUrl, message.body, {
      groupId: message.groupId,
      deduplicationId: message.deduplicationId,
      attributes: message.attributes,
    });
  }
  await waitFor(
    async () => (await countMessages(client, queueUrl)).total === messages.length,
    QUEUE_WAIT,
  );
};

const byBody = (
  messages: readonly ReceivedTestMessage[],
  body: string,
): ReceivedTestMessage | undefined => messages.find((message) => message.body === body);

describe('dlq:redrive', () => {
  let client: SQSClient;

  beforeAll(() => {
    client = createTestSqsClient();
  });

  afterAll(() => {
    client.destroy();
  });

  it('parses --force and only --force', () => {
    expect(parseRedriveArgs([])).toEqual({ force: false });
    expect(parseRedriveArgs([FORCE_FLAG])).toEqual({ force: true });
    expect(parseRedriveArgs(['--other'])).toEqual({ force: false });
  });

  it('skips terminal reasons to the end of the DLQ and redrives the rest without dlq attributes', async () => {
    const queues = await createTestQueues();
    const terminal = TERMINAL_DLQ_REASONS.map(terminalMessage);
    const withoutReason = dlqMessage({ correlationId: 'corr-plain' });
    const failedPath = dlqMessage({
      dlqReason: 'FAILED_PATH_ERROR',
      failureCode: 'PROCESSING_FAILED',
      originalMessageId: 'orig-failed-path',
      correlationId: 'corr-failed-path',
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    });
    await seed(client, queues.urls.wagerTransactionsDlq, [...terminal, withoutReason, failedPath]);

    const summary = await redriveDlq(redriveConfig(queues), { force: false });

    expect(summary).toEqual({
      redriven: 2,
      skipped: Object.fromEntries(TERMINAL_DLQ_REASONS.map((reason) => [reason, 1])),
      errors: 0,
    });

    const main = await peekMessages(client, queues.urls.wagerTransactions);
    expect(main).toHaveLength(2);
    for (const original of [withoutReason, failedPath]) {
      const redriven = byBody(main, original.body);
      expect(redriven?.groupId).toBe(original.groupId);
      expect(redriven?.deduplicationId).not.toBe(original.deduplicationId);
      expect(redriven?.deduplicationId).toMatch(UUID_V7);
      for (const name of DLQ_ATTRIBUTE_NAMES) {
        expect(redriven?.attributes[name]).toBeUndefined();
      }
    }
    expect(byBody(main, withoutReason.body)?.attributes).toEqual({ correlationId: 'corr-plain' });
    expect(byBody(main, failedPath.body)?.attributes).toEqual({
      correlationId: 'corr-failed-path',
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    });

    const dlq = await readDlq(client, queues.urls.wagerTransactionsDlq);
    expect(dlq).toHaveLength(terminal.length);
    for (const original of terminal) {
      const kept = byBody(dlq, original.body);
      expect(kept?.groupId).toBe(original.groupId);
      expect(kept?.deduplicationId).not.toBe(original.deduplicationId);
      expect(kept?.deduplicationId).toMatch(UUID_V7);
      expect(kept?.attributes).toEqual(original.attributes);
    }
  });

  it('includes terminal reasons with --force', async () => {
    const queues = await createTestQueues();
    const terminal = TERMINAL_DLQ_REASONS.map(terminalMessage);
    await seed(client, queues.urls.wagerTransactionsDlq, terminal);

    const summary = await redriveDlq(redriveConfig(queues), { force: true });

    expect(summary).toEqual({ redriven: terminal.length, skipped: {}, errors: 0 });
    expect(await countMessages(client, queues.urls.wagerTransactionsDlq)).toEqual({
      visible: 0,
      inFlight: 0,
      total: 0,
    });
    const main = await peekMessages(client, queues.urls.wagerTransactions);
    expect(main).toHaveLength(terminal.length);
    for (const original of terminal) {
      const redriven = byBody(main, original.body);
      expect(redriven?.groupId).toBe(original.groupId);
      expect(redriven?.attributes).toEqual({
        correlationId: `corr-${original.attributes.dlqReason ?? ''}`,
      });
    }
  });

  it('keeps the order of a group and stops on an empty receive when run again', async () => {
    const queues = await createTestQueues();
    const groupId = crypto.randomUUID();
    const ordered = [
      dlqMessage({ dlqReason: 'FAILED_PATH_ERROR' }, groupId),
      dlqMessage({ dlqReason: 'FAILED_PATH_ERROR' }, groupId),
      dlqMessage({}, groupId),
    ];
    await seed(client, queues.urls.wagerTransactionsDlq, ordered);

    const first = await redriveDlq(redriveConfig(queues), { force: false });
    const second = await redriveDlq(redriveConfig(queues), { force: false });

    expect(first).toEqual({ redriven: 3, skipped: {}, errors: 0 });
    expect(second).toEqual({ redriven: 0, skipped: {}, errors: 0 });
    const main = await peekMessages(client, queues.urls.wagerTransactions);
    expect(main.map((message) => message.body)).toEqual(ordered.map((message) => message.body));
    expect(main.map((message) => parseEnvelope(message))).toEqual(
      ordered.map((message): unknown => JSON.parse(message.body)),
    );
  });

  it('stops when the skipped messages come back and leaves them for the next run', async () => {
    const queues = await createTestQueues();
    const terminal = [terminalMessage('INVALID_PAYLOAD'), terminalMessage('INVALID_PAYLOAD')];
    await seed(client, queues.urls.wagerTransactionsDlq, terminal);

    const first = await redriveDlq(redriveConfig(queues), { force: false });
    const second = await redriveDlq(redriveConfig(queues), { force: false });

    expect(first).toEqual({ redriven: 0, skipped: { INVALID_PAYLOAD: 2 }, errors: 0 });
    expect(second).toEqual(first);
    expect((await countMessages(client, queues.urls.wagerTransactionsDlq)).total).toBe(2);
    expect((await countMessages(client, queues.urls.wagerTransactions)).total).toBe(0);
  });

  it('prints the summary when run as a script with --force', async () => {
    const queues = await createTestQueues();
    await seed(client, queues.urls.wagerTransactionsDlq, [
      terminalMessage('PROCESSING_FAILED'),
      dlqMessage({}),
    ]);
    const config = redriveConfig(queues);

    const child = Bun.spawn([process.execPath, SCRIPT_PATH, FORCE_FLAG], {
      cwd: PROJECT_ROOT,
      env: {
        PATH: process.env.PATH ?? '',
        DATABASE_URL: 'postgres://unused',
        SQS_ENDPOINT: config.SQS_ENDPOINT,
        AWS_REGION: config.AWS_REGION,
        AWS_ACCESS_KEY_ID: config.AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: config.AWS_SECRET_ACCESS_KEY,
        WAGER_QUEUE_NAME: config.WAGER_QUEUE_NAME,
        WAGER_DLQ_NAME: config.WAGER_DLQ_NAME,
        SQS_RECEIVE_WAIT_SECONDS: String(config.SQS_RECEIVE_WAIT_SECONDS),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(formatSummary({ redriven: 2, skipped: {}, errors: 0 }));
    expect(stdout.trim()).toBe('dlq redrive: redriven=2 skipped=0 errors=0');
    expect((await countMessages(client, queues.urls.wagerTransactions)).total).toBe(2);
  });

  it('formats skipped reasons in the summary', () => {
    expect(
      formatSummary({
        redriven: 1,
        skipped: { PROCESSING_FAILED: 2, INVALID_PAYLOAD: 1 },
        errors: 1,
      }),
    ).toBe('dlq redrive: redriven=1 skipped=3 (INVALID_PAYLOAD=1, PROCESSING_FAILED=2) errors=1');
  });
});
