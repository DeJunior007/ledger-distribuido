export type ContextEnricher = (fields: {
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}) => void;
