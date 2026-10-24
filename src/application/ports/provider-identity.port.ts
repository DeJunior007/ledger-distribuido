export type Identity =
  | { kind: 'provider'; providerId: string; clientId: string }
  | { kind: 'operator'; clientId: string }
  | { kind: 'trusted-channel' };

export abstract class ProviderIdentityPort {
  abstract resolve(bearerToken: string): Promise<Identity>;
}

export const TRUSTED_CHANNEL: Identity = { kind: 'trusted-channel' };
