import { Controller, HttpCode, HttpStatus, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { IdGeneratorPort } from '@application/ports/id-generator.port';
import { ReconcileWalletUseCase } from '@application/use-cases/reconcile-wallet.use-case';
import type { ChainProblem } from '@domain/reconciliation/ledger-chain';
import type { WalletReconciliationReport } from '@domain/reconciliation/reconciliation-report';
import type { MoneyProps } from '@domain/shared/money';
import { ensureCorrelation } from '../correlation.middleware';
import { Roles } from '../roles.decorator';
import { ZodValidationPipe } from '../zod-validation.pipe';
import { walletParamsSchema, type WalletParams } from './wallets.controller';

export interface ReconciliationResponse {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
  chain: {
    valid: boolean;
    firstDivergentVersion: number | null;
    problems: ChainProblem[];
  };
  runId: string;
  checkedAt: string;
}

const toResponse = (report: WalletReconciliationReport): ReconciliationResponse => ({
  walletId: report.walletId,
  storedBalance: report.storedBalance.toJSON(),
  calculatedBalance: report.calculatedBalance.toJSON(),
  difference: report.difference.toJSON(),
  consistent: report.consistent,
  checkedEntries: report.checkedEntries,
  chain: {
    valid: report.chain.valid,
    firstDivergentVersion: report.chain.firstDivergentVersion ?? null,
    problems: report.chain.problems,
  },
  runId: report.runId,
  checkedAt: report.checkedAt.toISOString(),
});

@Controller('wallets')
export class ReconciliationController {
  constructor(
    private readonly reconcileWallet: ReconcileWalletUseCase,
    private readonly ids: IdGeneratorPort,
  ) {}

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  @Roles('operator')
  async reconcile(
    @Param(new ZodValidationPipe(walletParamsSchema)) params: WalletParams,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReconciliationResponse> {
    const { correlationId } = ensureCorrelation(request, response, this.ids);
    const report = await this.reconcileWallet.execute({
      walletId: params.walletId,
      correlationId,
    });
    return toResponse(report);
  }
}
