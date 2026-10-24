import type { ProblemBody, TransactionResultBody } from '@domain/idempotency/response-bodies';
import type { MoneyProps } from '@domain/shared/money';
import type { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import type { Identity } from '@application/ports/provider-identity.port';

export type Channel = 'http' | 'sqs';

export interface SubmitWagerTransactionCommand {
  channel: Channel;
  identity: Identity;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId: string | undefined;
  correlationId: string;
  causationId: string;
  inbox: { messageId: string; payloadHash: string } | undefined;
}

export type SubmitResult =
  | {
      kind: 'outcome';
      httpStatus: 200 | 202 | 422 | 500;
      body: TransactionResultBody;
      replay: boolean;
    }
  | { kind: 'external-id-conflict'; body: ProblemBody; replay: boolean }
  | { kind: 'idempotency-key-conflict'; body: ProblemBody }
  | { kind: 'inbox-payload-mismatch' };
