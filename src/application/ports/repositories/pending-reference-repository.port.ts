export interface PendingReferenceRetry {
  transactionId: string;
  attempts: number;
  consecutiveErrors: number;
  nextAttemptAt: Date;
  deadlineAt: Date;
  lockedUntil: Date | undefined;
  lockedBy: string | undefined;
  resolvedAt: Date | undefined;
  createdAt: Date;
}

export abstract class PendingReferenceRepositoryPort {
  abstract insert(retry: PendingReferenceRetry): void;
  abstract claimDue(input: {
    instanceId: string;
    leaseMs: number;
    limit: number;
  }): Promise<PendingReferenceRetry[]>;
  abstract renewLease(transactionId: string, instanceId: string, leaseMs: number): Promise<boolean>;
  abstract scheduleNext(input: {
    transactionId: string;
    instanceId: string;
    nextAttemptAt: Date;
    attempts: number;
    consecutiveErrors: number;
  }): Promise<boolean>;
  abstract markResolved(transactionId: string, at: Date): Promise<void>;
  abstract wakeDependents(providerId: string, externalTransactionId: string): Promise<number>;
  abstract openCount(): Promise<number>;
}
