export interface InboxMessageRecordProps {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

export class InboxMessageRecord {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;

  constructor(props: InboxMessageRecordProps) {
    this.consumerName = props.consumerName;
    this.messageId = props.messageId;
    this.payloadHash = props.payloadHash;
    this.receivedAt = props.receivedAt;
    this.processedAt = props.processedAt;
  }
}
