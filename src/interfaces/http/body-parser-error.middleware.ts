import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { hasDuplicateJsonKey } from './json-duplicate-keys';

export const JSON_BODY_LIMIT = '16kb';
const JSON_PARSE_FAILED_TYPE = 'entity.parse.failed';
const JSON_DUPLICATE_KEY_TYPE = 'entity.duplicate.key';
const UNSUPPORTED_CHARSET_TYPE = 'charset.unsupported';

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

const JSON_CHARSET = 'utf-8';

const decodeBody = (body: Buffer, charset: string): string => {
  if (charset !== JSON_CHARSET) {
    throw new BodyParserError(UNSUPPORTED_CHARSET_TYPE);
  }
  return new TextDecoder(JSON_CHARSET).decode(body);
};

const isJsonDocument = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

export const rejectDuplicateJsonKeys = (
  _request: IncomingMessage,
  _response: ServerResponse,
  body: Buffer,
  charset: string,
): void => {
  if (body.length === 0) {
    return;
  }
  const text = decodeBody(body, charset);
  if (!isJsonDocument(text)) {
    throw new BodyParserError(JSON_PARSE_FAILED_TYPE);
  }
  if (hasDuplicateJsonKey(text)) {
    throw new BodyParserError(JSON_DUPLICATE_KEY_TYPE);
  }
};

export const useJsonBodyParser = (app: NestExpressApplication): void => {
  const options = { limit: JSON_BODY_LIMIT, verify: rejectDuplicateJsonKeys };
  app.useBodyParser('json', options);
  app.use(bodyParserErrorTranslator);
};
