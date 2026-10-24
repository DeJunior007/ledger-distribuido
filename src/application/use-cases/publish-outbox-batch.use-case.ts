import { ClockPort } from '@application/ports/clock.port';
import { EventPublisherPort, type PublishOutcome } from '@application/ports/event-publisher.port';
import { FaultInjectorPort } from '@application/ports/fault-injector.port';
import { LoggerPort } from '@application/ports/logger.port';
import { MetricsPort } from '@application/ports/metrics.port';
import { UnitOfWorkPort, type Repositories } from '@application/ports/unit-of-work.port';
import type { OutboxMessage } from '@domain/messaging/outbox-message';

const MAX_JITTER_RATIO = 0.2;

export interface PublishOutboxBatchOptions {
  instanceId: string;
  leaseMs: number;
  batchSize: number;
}

export interface PublishOutboxBatchResult {
  claimed: number;
  full: boolean;
  connectivityFailure: boolean;
}

export class PublishOutboxBatchUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly publisher: EventPublisherPort,
    private readonly clock: ClockPort,
    private readonly faults: FaultInjectorPort,
    private readonly metrics: MetricsPort,
    private readonly logger: LoggerPort,
    private readonly options: PublishOutboxBatchOptions,
  ) {}

  async execute(): Promise<PublishOutboxBatchResult> {
    const claimed = await this.unitOfWork.run('short', (repos) =>
      repos.outbox.claimDue({
        instanceId: this.options.instanceId,
        leaseMs: this.options.leaseMs,
        limit: this.options.batchSize,
      }),
    );
    if (claimed.length === 0) {
      return { claimed: 0, full: false, connectivityFailure: false };
    }
    this.faults.hit('outbox.after_claim_before_publish');
    const { outcomes, connectivityFailure } = await this.publisher.publishBatch(claimed);
    this.recordPublishResults(outcomes);
    this.faults.hit('outbox.after_publish_before_mark');
    const messages = new Map(claimed.map((message) => [message.id, message]));
    const marked = await this.unitOfWork.run('short', (repos) =>
      this.applyOutcomes(repos, messages, outcomes),
    );
    for (const message of marked.published) {
      this.metrics.outboxPublishLatency(
        (marked.at.getTime() - message.occurredAt.getTime()) / 1000,
      );
    }
    return {
      claimed: claimed.length,
      full: claimed.length === this.options.batchSize,
      connectivityFailure,
    };
  }

  private recordPublishResults(outcomes: readonly PublishOutcome[]): void {
    for (const outcome of outcomes) {
      if (outcome.result === 'published') {
        this.metrics.outboxPublished('published');
      } else {
        this.metrics.outboxPublished(outcome.kind === 'PERMANENT' ? 'permanent' : 'transient');
      }
    }
  }

  private async applyOutcomes(
    repos: Repositories,
    messages: ReadonlyMap<string, OutboxMessage>,
    outcomes: readonly PublishOutcome[],
  ): Promise<{ at: Date; published: OutboxMessage[] }> {
    const at = this.clock.now();
    const published: OutboxMessage[] = [];
    for (const outcome of outcomes) {
      const message = messages.get(outcome.id);
      if (message === undefined) {
        continue;
      }
      const kept =
        outcome.result === 'published'
          ? await repos.outbox.markPublished(message.id, this.options.instanceId, at)
          : await this.saveRetry(repos, message, outcome, at);
      if (!kept) {
        this.logger.warn('outbox lease lost; another instance took over the event', {
          eventId: message.id,
        });
        continue;
      }
      if (outcome.result === 'published') {
        published.push(message);
      }
    }
    return { at, published };
  }

  private saveRetry(
    repos: Repositories,
    message: OutboxMessage,
    outcome: Extract<PublishOutcome, { result: 'failed' }>,
    now: Date,
  ): Promise<boolean> {
    message.scheduleRetry({
      now,
      kind: outcome.kind,
      errorCode: outcome.errorCode,
      jitterRatio: Math.random() * MAX_JITTER_RATIO,
    });
    return repos.outbox.saveRetry(message, this.options.instanceId);
  }
}
