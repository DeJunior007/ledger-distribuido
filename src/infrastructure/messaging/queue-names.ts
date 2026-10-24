export const QueueNames = {
  WagerTransactions: 'wager-transactions.fifo',
  WagerTransactionsDlq: 'wager-transactions-dlq.fifo',
  WalletEvents: 'wallet-events.fifo',
} as const;

export type QueueName = (typeof QueueNames)[keyof typeof QueueNames];
