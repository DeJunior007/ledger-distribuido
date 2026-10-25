import { Controller, Get, Param } from '@nestjs/common';
import { z } from 'zod';
import type { Identity } from '@application/ports/provider-identity.port';
import { GetWagerTransactionByExternalIdUseCase } from '@application/use-cases/get-wager-transaction-by-external-id.use-case';
import type { WagerTransactionView } from '@application/views/wager-transaction.view';
import { CurrentIdentity } from '../current-identity.decorator';
import { Roles } from '../roles.decorator';
import { EXTERNAL_ID_PATTERN, PROVIDER_ID_PATTERN } from '../schemas/wager-transaction.schema';
import { ZodValidationPipe } from '../zod-validation.pipe';

export interface ProviderTransactionParams {
  providerId: string;
  externalTransactionId: string;
}

export const providerTransactionParamsSchema: z.ZodType<
  ProviderTransactionParams,
  z.ZodTypeDef,
  unknown
> = z
  .object({
    providerId: z.string().regex(PROVIDER_ID_PATTERN),
    externalTransactionId: z.string().regex(EXTERNAL_ID_PATTERN),
  })
  .strict();

@Controller('providers/:providerId/wagering/transactions')
export class ProviderTransactionsController {
  constructor(private readonly getByExternalId: GetWagerTransactionByExternalIdUseCase) {}

  @Get(':externalTransactionId')
  @Roles('provider', 'operator')
  find(
    @Param(new ZodValidationPipe(providerTransactionParamsSchema))
    params: ProviderTransactionParams,
    @CurrentIdentity() identity: Identity,
  ): Promise<WagerTransactionView> {
    return this.getByExternalId.execute({
      providerId: params.providerId,
      externalTransactionId: params.externalTransactionId,
      identity,
    });
  }
}
