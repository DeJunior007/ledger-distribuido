import type { IncomingHttpHeaders } from 'node:http';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { UnauthenticatedError } from '@application/errors/unauthenticated.error';
import type { Identity } from '@application/ports/provider-identity.port';

const IDENTITY = Symbol('identity');

export interface IdentityCarrier {
  readonly headers: IncomingHttpHeaders;
  [IDENTITY]?: Identity;
}

export const attachIdentity = (request: IdentityCarrier, identity: Identity): void => {
  request[IDENTITY] = identity;
};

export const identityOf = (request: IdentityCarrier): Identity => {
  const identity = request[IDENTITY];
  if (identity === undefined) {
    throw new UnauthenticatedError('request without an authenticated identity');
  }
  return identity;
};

export const currentIdentityOf = (context: ExecutionContext): Identity =>
  identityOf(context.switchToHttp().getRequest<IdentityCarrier>());

export const CurrentIdentity = createParamDecorator((_data: unknown, context: ExecutionContext) =>
  currentIdentityOf(context),
);
