export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string | undefined;
  occurredAt: Date;
  data: T;
}

export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId: string | undefined;
  occurredAt: Date;
}

export interface IntegrationEventJson<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = new Date(props.occurredAt.getTime());
    this.data = Object.freeze({ ...props.data });
  }

  protected static propsFrom<D>(
    ctx: EventContext,
    aggregateId: string,
    data: D,
  ): IntegrationEventProps<D> {
    return {
      eventId: ctx.eventId,
      aggregateId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data,
    };
  }

  toJSON(): IntegrationEventJson<T> {
    const base = {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
    };
    const tail = {
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: { ...this.data },
    };
    if (this.causationId === undefined) {
      return { ...base, ...tail };
    }
    return { ...base, causationId: this.causationId, ...tail };
  }
}
