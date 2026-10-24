import type { MoneyProps } from '@domain/shared/money';
import { WagerTransactionKind } from '@domain/wagering/wager-transaction-kind';
import type { SubmitWagerTransactionCommand } from '@application/commands/submit-wager-transaction.command';
import type { HasherPort } from '@application/ports/hasher.port';
import { canonicalJson, type CanonicalValue } from './canonical-json';

export function idempotencyHashInput(command: SubmitWagerTransactionCommand): CanonicalValue {
  return {
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    playerId: command.playerId,
    walletId: command.walletId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    money: { amount: command.money.amount, currency: command.money.currency },
    referenceExternalTransactionId: command.referenceExternalTransactionId,
  };
}

export function computePayloadHash(
  command: SubmitWagerTransactionCommand,
  hasher: HasherPort,
): string {
  return hasher.sha256Hex(canonicalJson(idempotencyHashInput(command)));
}

export function computeOpeningPayloadHash(
  input: { walletId: string; money: MoneyProps },
  hasher: HasherPort,
): string {
  return hasher.sha256Hex(
    canonicalJson({
      kind: WagerTransactionKind.Opening,
      walletId: input.walletId,
      money: { amount: input.money.amount, currency: input.money.currency },
    }),
  );
}

export function computeInboxHash(data: CanonicalValue, hasher: HasherPort): string {
  return hasher.sha256Hex(canonicalJson(data));
}

export function computeRawBodyHash(body: string, hasher: HasherPort): string {
  return hasher.sha256Hex(body);
}
