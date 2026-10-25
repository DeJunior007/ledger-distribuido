import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenError } from '@application/errors/forbidden.error';
import { UnauthenticatedError } from '@application/errors/unauthenticated.error';
import { ProviderIdentityPort } from '@application/ports/provider-identity.port';
import { requestContext } from '@infrastructure/observability/request-context';
import { attachIdentity, type IdentityCarrier } from './current-identity.decorator';
import { IS_PUBLIC_KEY } from './public.decorator';
import { ROLES_KEY, type IdentityKind } from './roles.decorator';

const BEARER_FORMAT = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/;

const bearerTokenOf = (request: IdentityCarrier): string => {
  const header = request.headers.authorization;
  const token = typeof header === 'string' ? BEARER_FORMAT.exec(header)?.[1] : undefined;
  if (token === undefined) {
    throw new UnauthenticatedError('missing or malformed bearer token');
  }
  return token;
};

export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly providerIdentity: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, targets) === true) {
      return true;
    }
    const request = context.switchToHttp().getRequest<IdentityCarrier>();
    const identity = await this.providerIdentity.resolve(bearerTokenOf(request));
    const allowed =
      this.reflector.getAllAndOverride<readonly IdentityKind[] | undefined>(ROLES_KEY, targets) ??
      [];
    if (!allowed.includes(identity.kind)) {
      throw new ForbiddenError(`role ${identity.kind} is not allowed on this route`);
    }
    attachIdentity(request, identity);
    if (identity.kind === 'provider') {
      requestContext.enrich({ providerId: identity.providerId });
    }
    return true;
  }
}
