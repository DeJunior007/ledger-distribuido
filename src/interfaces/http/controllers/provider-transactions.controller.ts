import { Controller, Get, Param } from '@nestjs/common';
import type { Identity } from '@application/ports/provider-identity.port';
import { GetWagerTransactionByExternalIdUseCase } from '@application/use-cases/get-wager-transaction-by-external-id.use-case';
import type { WagerTransactionView } from '@application/views/wager-transaction.view';
import { CurrentIdentity } from '../current-identity.decorator';
import { Roles } from '../roles.decorator';

@Controller('providers/:providerId/wagering/transactions')
export class ProviderTransactionsController {
  constructor(private readonly getByExternalId: GetWagerTransactionByExternalIdUseCase) {}

  @Get(':externalTransactionId')
  @Roles('provider', 'operator')
  find(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
    @CurrentIdentity() identity: Identity,
  ): Promise<WagerTransactionView> {
    return this.getByExternalId.execute({ providerId, externalTransactionId, identity });
  }
}
