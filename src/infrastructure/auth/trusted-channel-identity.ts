import { ProviderIdentityPort, TRUSTED_CHANNEL } from '@application/ports/provider-identity.port';
import type { Identity } from '@application/ports/provider-identity.port';

export class TrustedChannelIdentity extends ProviderIdentityPort {
  resolve(): Promise<Identity> {
    return Promise.resolve(TRUSTED_CHANNEL);
  }
}
