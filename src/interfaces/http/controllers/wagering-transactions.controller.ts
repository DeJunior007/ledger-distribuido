import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ProblemBody, TransactionResultBody } from '@domain/idempotency/response-bodies';
import type { SubmitResult } from '@application/commands/submit-wager-transaction.command';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import { FaultInjectorPort } from '@application/ports/fault-injector.port';
import { IdGeneratorPort } from '@application/ports/id-generator.port';
import type { Identity } from '@application/ports/provider-identity.port';
import { GetWagerTransactionUseCase } from '@application/use-cases/get-wager-transaction.use-case';
import { SubmitWagerTransactionUseCase } from '@application/use-cases/submit-wager-transaction.use-case';
import type { WagerTransactionView } from '@application/views/wager-transaction.view';
import { ensureCorrelation } from '../correlation.middleware';
import { CurrentIdentity } from '../current-identity.decorator';
import { PROBLEM_CONTENT_TYPE } from '../http-status';
import { Roles } from '../roles.decorator';
import { uuidSchema, type WagerTransactionRequest } from '../schemas/wager-transaction.schema';
import { ZodValidationPipe } from '../zod-validation.pipe';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

export interface WagerTransactionParams {
  transactionId: string;
}

export const wagerTransactionParamsSchema: z.ZodType<
  WagerTransactionParams,
  z.ZodTypeDef,
  unknown
> = z.object({ transactionId: uuidSchema }).strict();

export class WagerTransactionRequestPipe extends ZodValidationPipe<WagerTransactionRequest> {}

const respond = (result: SubmitResult, response: Response): TransactionResultBody | ProblemBody => {
  switch (result.kind) {
    case 'outcome':
      response.status(result.httpStatus);
      return result.body;
    case 'external-id-conflict':
    case 'idempotency-key-conflict':
      response.status(HttpStatus.CONFLICT).type(PROBLEM_CONTENT_TYPE);
      return result.body;
    case 'inbox-payload-mismatch':
      throw new TechnicalError(ErrorClass.Deterministic, 'deterministic');
  }
};

@Controller('wagering/transactions')
export class WageringTransactionsController {
  constructor(
    private readonly submitTransaction: SubmitWagerTransactionUseCase,
    private readonly getTransaction: GetWagerTransactionUseCase,
    private readonly requestPipe: WagerTransactionRequestPipe,
    private readonly faults: FaultInjectorPort,
    private readonly ids: IdGeneratorPort,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @Roles('provider')
  async submit(
    @Body() body: unknown,
    @CurrentIdentity() identity: Identity,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TransactionResultBody | ProblemBody> {
    const input = this.requestPipe.transform({
      idempotencyKey: request.headers[IDEMPOTENCY_KEY_HEADER],
      body,
    });
    const { requestId, correlationId } = ensureCorrelation(request, response, this.ids);
    const result = await this.submitTransaction.execute({
      channel: 'http',
      identity,
      providerId: input.body.providerId,
      externalTransactionId: input.body.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      playerId: input.body.playerId,
      walletId: input.body.walletId,
      roundId: input.body.roundId,
      gameId: input.body.gameId,
      kind: input.body.kind,
      money: input.body.money,
      referenceExternalTransactionId: input.body.referenceExternalTransactionId,
      correlationId,
      causationId: requestId,
      inbox: undefined,
    });
    this.faults.hit('api.after_commit_before_response');
    return respond(result, response);
  }

  @Get(':transactionId')
  @Roles('provider', 'operator')
  find(
    @Param(new ZodValidationPipe(wagerTransactionParamsSchema)) params: WagerTransactionParams,
    @CurrentIdentity() identity: Identity,
  ): Promise<WagerTransactionView> {
    return this.getTransaction.execute({ transactionId: params.transactionId, identity });
  }
}
