import type { JWTPayload } from 'jose';
import { ForbiddenError } from '@application/errors/forbidden.error';
import { ProviderIdentityPort } from '@application/ports/provider-identity.port';
import type { Identity } from '@application/ports/provider-identity.port';
import type { JwksTokenVerifier } from './jwks-token-verifier';

const PROVIDER_ROLE = 'provider';
const OPERATOR_ROLE = 'operator';
const PROVIDER_ID_FORMAT = /^[a-z0-9][a-z0-9-]{1,62}$/;

const realmRolesOf = (payload: JWTPayload): readonly string[] => {
  const realmAccess: unknown = payload.realm_access;
  if (typeof realmAccess !== 'object' || realmAccess === null) {
    return [];
  }
  const roles: unknown = Reflect.get(realmAccess, 'roles');
  if (!Array.isArray(roles)) {
    return [];
  }
  return roles.filter((role: unknown): role is string => typeof role === 'string');
};

const providerIdOf = (payload: JWTPayload): string | undefined => {
  const providerId: unknown = payload.provider_id;
  return typeof providerId === 'string' && PROVIDER_ID_FORMAT.test(providerId)
    ? providerId
    : undefined;
};

const clientIdOf = (payload: JWTPayload): string | undefined => {
  const clientId: unknown = payload.azp;
  return typeof clientId === 'string' && clientId.length > 0 ? clientId : undefined;
};

export class JwtProviderIdentityAdapter extends ProviderIdentityPort {
  constructor(private readonly verifier: JwksTokenVerifier) {
    super();
  }

  async resolve(bearerToken: string): Promise<Identity> {
    const payload = await this.verifier.verify(bearerToken);
    const clientId = clientIdOf(payload);
    if (clientId === undefined) {
      throw new ForbiddenError('token without client id');
    }
    const roles = realmRolesOf(payload);
    if (roles.includes(OPERATOR_ROLE)) {
      return { kind: 'operator', clientId };
    }
    const providerId = providerIdOf(payload);
    if (roles.includes(PROVIDER_ROLE) && providerId !== undefined) {
      return { kind: 'provider', providerId, clientId };
    }
    throw new ForbiddenError('token without an allowed role');
  }
}
