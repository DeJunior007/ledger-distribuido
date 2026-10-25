import { Body, Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { IdGeneratorPort } from '@application/ports/id-generator.port';
import type { Identity } from '@application/ports/provider-identity.port';
import { CreateWalletUseCase } from '@application/use-cases/create-wallet.use-case';
import { GetWalletUseCase } from '@application/use-cases/get-wallet.use-case';
import { ListLedgerUseCase } from '@application/use-cases/list-ledger.use-case';
import type { WalletLedgerEntryView } from '@application/views/wallet-ledger-entry.view';
import type { WalletBalanceView, WalletView } from '@application/views/wallet.view';
import { FailureCode } from '@domain/shared/failure-code';
import type { MoneyProps } from '@domain/shared/money';
import { ensureCorrelation } from '../correlation.middleware';
import { CurrentIdentity } from '../current-identity.decorator';
import { Roles } from '../roles.decorator';
import type { CreateWalletBody } from '../schemas/create-wallet.schema';
import {
  encodeLedgerCursor,
  ledgerQuerySchema,
  type LedgerQuery,
} from '../schemas/ledger-query.schema';
import { uuidSchema } from '../schemas/wager-transaction.schema';
import { RequestValidationError, ZodValidationPipe } from '../zod-validation.pipe';

export interface WalletParams {
  walletId: string;
}

export const walletParamsSchema: z.ZodType<WalletParams, z.ZodTypeDef, unknown> = z
  .object({ walletId: uuidSchema })
  .strict();

export class CreateWalletBodyPipe extends ZodValidationPipe<CreateWalletBody> {}

export interface CreatedWalletResponse {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface LedgerPageResponse {
  walletId: string;
  entries: WalletLedgerEntryView[];
  nextCursor: string | null;
}

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
    private readonly listLedger: ListLedgerUseCase,
    private readonly createWalletBody: CreateWalletBodyPipe,
    private readonly ids: IdGeneratorPort,
  ) {}

  @Post()
  @Roles('operator')
  async create(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CreatedWalletResponse> {
    const input = this.createWalletBody.transform(body);
    const { requestId, correlationId } = ensureCorrelation(request, response, this.ids);
    const wallet = await this.createWallet.execute({
      playerId: input.playerId,
      initialBalance: input.initialBalance,
      correlationId,
      causationId: requestId,
    });
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance,
      version: wallet.version,
    };
  }

  @Get(':walletId')
  @Roles('provider', 'operator')
  find(
    @Param(new ZodValidationPipe(walletParamsSchema)) params: WalletParams,
    @CurrentIdentity() identity: Identity,
  ): Promise<WalletView | WalletBalanceView> {
    return this.getWallet.execute({ walletId: params.walletId, identity });
  }

  @Get(':walletId/ledger')
  @Roles('operator')
  async ledger(
    @Param(new ZodValidationPipe(walletParamsSchema)) params: WalletParams,
    @Query(new ZodValidationPipe(ledgerQuerySchema)) query: LedgerQuery,
  ): Promise<LedgerPageResponse> {
    if (query.cursor !== undefined && query.cursor.walletId !== params.walletId) {
      throw new RequestValidationError(FailureCode.InvalidPayload, [
        { path: 'cursor', message: 'cursor belongs to another wallet' },
      ]);
    }
    const page = await this.listLedger.execute({
      walletId: params.walletId,
      beforeVersion: query.cursor?.walletVersion,
      limit: query.limit,
    });
    return {
      walletId: params.walletId,
      entries: page.entries,
      nextCursor:
        page.nextBeforeVersion === undefined
          ? null
          : encodeLedgerCursor(params.walletId, page.nextBeforeVersion),
    };
  }
}
