import type { NextFunction, Request, Response } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';

export const JSON_BODY_LIMIT = '16kb';

export class BodyParserError extends Error {
  readonly type: string;

  constructor(type: string) {
    super(`request body rejected by the parser: ${type}`);
    this.name = 'BodyParserError';
    this.type = type;
  }
}

const bodyParserTypeOf = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null || !('type' in error)) {
    return undefined;
  }
  return typeof error.type === 'string' ? error.type : undefined;
};

export const bodyParserErrorTranslator = (
  error: unknown,
  _request: Request,
  _response: Response,
  next: NextFunction,
): void => {
  const type = bodyParserTypeOf(error);
  next(type === undefined ? error : new BodyParserError(type));
};

export const useJsonBodyParser = (app: NestExpressApplication): void => {
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.use(bodyParserErrorTranslator);
};
