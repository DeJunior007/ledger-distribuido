import { InvalidInboxTransitionError } from './errors/invalid-inbox-transition.error';

export interface InboxMessageState {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | undefined;
}

export class InboxMessage {
  private constructor(private state: InboxMessageState) {}

  get consumerName(): string {
    return this.state.consumerName;
  }

  get messageId(): string {
    return this.state.messageId;
  }

  get payloadHash(): string {
    return this.state.payloadHash;
  }

  get receivedAt(): Date {
    return this.state.receivedAt;
  }

  get processedAt(): Date | undefined {
    return this.state.processedAt;
  }

  static receive(props: {
    consumerName: string;
    messageId: string;
    payloadHash: string;
    now: Date;
  }): InboxMessage {
    return new InboxMessage({
      consumerName: props.consumerName,
      messageId: props.messageId,
      payloadHash: props.payloadHash,
      receivedAt: props.now,
      processedAt: undefined,
    });
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage({ ...state });
  }

  isProcessed(): boolean {
    return this.state.processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvalidInboxTransitionError(
        `Inbox message ${this.state.messageId} is already processed`,
      );
    }
    this.state = { ...this.state, processedAt: at };
  }

  matchesPayload(payloadHash: string): boolean {
    return this.state.payloadHash === payloadHash;
  }

  toState(): InboxMessageState {
    return { ...this.state };
  }
}
