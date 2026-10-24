export interface LogFields {
  correlationId?: string;
  requestId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  eventId?: string;
  component?: string;
  failureCode?: string;
  reason?: string;
  errorClass?: string;
  dlqReason?: string;
  durationMs?: number;
  attempt?: number;
  firstDivergentVersion?: number;
  problems?: readonly string[];
}

export abstract class LoggerPort {
  abstract info(message: string, fields?: LogFields): void;
  abstract warn(message: string, fields?: LogFields): void;
  abstract error(message: string, fields?: LogFields): void;
}
