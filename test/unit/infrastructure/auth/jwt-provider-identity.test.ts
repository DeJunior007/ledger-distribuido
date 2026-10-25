import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { CryptoKey, JWTPayload } from 'jose';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import { ForbiddenError } from '@application/errors/forbidden.error';
import { UnauthenticatedError } from '@application/errors/unauthenticated.error';
import { TRUSTED_CHANNEL } from '@application/ports/provider-identity.port';
import type { ProviderIdentityPort } from '@application/ports/provider-identity.port';
import { JwksTokenVerifier } from '@infrastructure/auth/jwks-token-verifier';
import { JwtProviderIdentityAdapter } from '@infrastructure/auth/jwt-provider-identity.adapter';
import { TrustedChannelIdentity } from '@infrastructure/auth/trusted-channel-identity';

const AUDIENCE = 'wagering-api';
const KEY_ID = 'test-key';

interface LocalIssuer {
  readonly issuer: string;
  readonly jwksUrl: string;
  readonly signingKey: CryptoKey;
  readonly foreignKey: CryptoKey;
  stop(): Promise<void>;
}

interface TokenOptions {
  readonly claims?: JWTPayload;
  readonly issuer?: string;
  readonly audience?: string;
  readonly expiresAt?: number;
  readonly key?: CryptoKey;
}

const nowInSeconds = (): number => Math.floor(Date.now() / 1000);

const startLocalIssuer = async (): Promise<LocalIssuer> => {
  const signing = await generateKeyPair('RS256');
  const foreign = await generateKeyPair('RS256');
  const publicJwk = { ...(await exportJWK(signing.publicKey)), kid: KEY_ID, alg: 'RS256' };
  const server = Bun.serve({
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === '/certs'
        ? Response.json({ keys: [publicJwk] })
        : new Response(null, { status: 404 }),
  });
  const base = `http://127.0.0.1:${String(server.port)}`;
  return {
    issuer: `${base}/realms/jungle`,
    jwksUrl: `${base}/certs`,
    signingKey: signing.privateKey,
    foreignKey: foreign.privateKey,
    stop: () => server.stop(true),
  };
};

const closedPortUrl = async (): Promise<string> => {
  const server = Bun.serve({ port: 0, fetch: () => new Response(null) });
  const url = `http://127.0.0.1:${String(server.port)}/certs`;
  await server.stop(true);
  return url;
};

const captureFailure = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );

describe('JwtProviderIdentityAdapter', () => {
  let localIssuer: LocalIssuer;
  let adapter: ProviderIdentityPort;

  const sign = (options: TokenOptions = {}): Promise<string> =>
    new SignJWT({ azp: 'provider-a', ...options.claims })
      .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
      .setIssuer(options.issuer ?? localIssuer.issuer)
      .setAudience(options.audience ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(options.expiresAt ?? nowInSeconds() + 300)
      .sign(options.key ?? localIssuer.signingKey);

  const providerClaims = (providerId: unknown): JWTPayload => ({
    realm_access: { roles: ['provider', 'default-roles-jungle'] },
    provider_id: providerId,
  });

  beforeAll(async () => {
    localIssuer = await startLocalIssuer();
    adapter = new JwtProviderIdentityAdapter(
      new JwksTokenVerifier({
        AUTH_ISSUER_URL: localIssuer.issuer,
        AUTH_JWKS_URL: localIssuer.jwksUrl,
        AUTH_AUDIENCE: AUDIENCE,
      }),
    );
  });

  afterAll(async () => {
    await localIssuer.stop();
  });

  it('resolves an operator from the realm roles and the azp claim', async () => {
    const token = await sign({
      claims: { azp: 'backoffice', realm_access: { roles: ['offline_access', 'operator'] } },
    });

    expect(await adapter.resolve(token)).toEqual({ kind: 'operator', clientId: 'backoffice' });
  });

  it('resolves a provider with a valid provider_id', async () => {
    const token = await sign({ claims: providerClaims('provider-a') });

    expect(await adapter.resolve(token)).toEqual({
      kind: 'provider',
      providerId: 'provider-a',
      clientId: 'provider-a',
    });
  });

  it('accepts a token expired within the 30 second clock tolerance', async () => {
    const token = await sign({
      claims: providerClaims('provider-a'),
      expiresAt: nowInSeconds() - 20,
    });

    expect(await adapter.resolve(token)).toMatchObject({ kind: 'provider' });
  });

  it.each([
    ['a provider without provider_id', providerClaims(undefined)],
    ['a provider with a malformed provider_id', providerClaims('Provider_A')],
    ['a provider with a non string provider_id', providerClaims(42)],
    ['a token without realm roles', { provider_id: 'provider-a' }],
    ['a token with only unrelated roles', { realm_access: { roles: ['offline_access'] } }],
    [
      'a provider_id without the provider role',
      { ...providerClaims('provider-a'), realm_access: { roles: ['uma_authorization'] } },
    ],
    ['a token without azp', { ...providerClaims('provider-a'), azp: undefined }],
  ])('rejects %s with ForbiddenError', async (_case, claims) => {
    const token = await sign({ claims });

    const failure = await captureFailure(adapter.resolve(token));

    expect(failure).toBeInstanceOf(ForbiddenError);
  });

  it('rejects a token expired beyond the clock tolerance', async () => {
    const token = await sign({
      claims: providerClaims('provider-a'),
      expiresAt: nowInSeconds() - 60,
    });

    const failure = await captureFailure(adapter.resolve(token));

    expect(failure).toBeInstanceOf(UnauthenticatedError);
  });

  it('rejects a token without an exp claim', async () => {
    const token = await new SignJWT({ azp: 'provider-a', ...providerClaims('provider-a') })
      .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
      .setIssuer(localIssuer.issuer)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .sign(localIssuer.signingKey);

    const failure = await captureFailure(adapter.resolve(token));

    expect(failure).toBeInstanceOf(UnauthenticatedError);
  });

  it('rejects a token from another issuer', async () => {
    const token = await sign({
      claims: providerClaims('provider-a'),
      issuer: 'http://localhost:8081/realms/other',
    });

    const failure = await captureFailure(adapter.resolve(token));

    expect(failure).toBeInstanceOf(UnauthenticatedError);
  });

  it('rejects a token for another audience', async () => {
    const token = await sign({ claims: providerClaims('provider-a'), audience: 'account' });

    const failure = await captureFailure(adapter.resolve(token));

    expect(failure).toBeInstanceOf(UnauthenticatedError);
  });

  it('rejects a token signed by another key with the same kid', async () => {
    const token = await sign({ claims: providerClaims('provider-a'), key: localIssuer.foreignKey });

    const failure = await captureFailure(adapter.resolve(token));

    expect(failure).toBeInstanceOf(UnauthenticatedError);
  });

  it('rejects a token signed with an algorithm other than RS256', async () => {
    const token = await new SignJWT(providerClaims('provider-a'))
      .setProtectedHeader({ alg: 'HS256', kid: KEY_ID })
      .setIssuer(localIssuer.issuer)
      .setAudience(AUDIENCE)
      .setExpirationTime(nowInSeconds() + 300)
      .sign(new TextEncoder().encode('a-shared-secret-with-at-least-32-bytes'));

    const failure = await captureFailure(adapter.resolve(token));

    expect(failure).toBeInstanceOf(UnauthenticatedError);
  });

  it('rejects a token whose kid is not in the key set', async () => {
    const token = await new SignJWT(providerClaims('provider-a'))
      .setProtectedHeader({ alg: 'RS256', kid: 'unknown-key' })
      .setIssuer(localIssuer.issuer)
      .setAudience(AUDIENCE)
      .setExpirationTime(nowInSeconds() + 300)
      .sign(localIssuer.signingKey);

    const failure = await captureFailure(adapter.resolve(token));

    expect(failure).toBeInstanceOf(UnauthenticatedError);
  });

  it('rejects a malformed token', async () => {
    const failure = await captureFailure(adapter.resolve('not-a-jwt'));

    expect(failure).toBeInstanceOf(UnauthenticatedError);
  });

  it('maps an unreachable key set to a connectivity error', async () => {
    const unreachable = new JwtProviderIdentityAdapter(
      new JwksTokenVerifier({
        AUTH_ISSUER_URL: localIssuer.issuer,
        AUTH_JWKS_URL: await closedPortUrl(),
        AUTH_AUDIENCE: AUDIENCE,
      }),
    );
    const token = await sign({ claims: providerClaims('provider-a') });

    const failure = await captureFailure(unreachable.resolve(token));

    expect(failure).toBeInstanceOf(TechnicalError);
    expect(failure).toMatchObject({ errorClass: ErrorClass.Connectivity, reason: 'connection' });
  });

  it('maps a key set timeout to a connectivity error', async () => {
    const stalled = Bun.serve({
      port: 0,
      fetch: async () => {
        await Bun.sleep(3000);
        return Response.json({ keys: [] });
      },
    });
    const timingOut = new JwtProviderIdentityAdapter(
      new JwksTokenVerifier({
        AUTH_ISSUER_URL: localIssuer.issuer,
        AUTH_JWKS_URL: `http://127.0.0.1:${String(stalled.port)}/certs`,
        AUTH_AUDIENCE: AUDIENCE,
      }),
    );
    const token = await sign({ claims: providerClaims('provider-a') });

    const failure = await captureFailure(timingOut.resolve(token));
    await stalled.stop(true);

    expect(failure).toBeInstanceOf(TechnicalError);
    expect(failure).toMatchObject({ errorClass: ErrorClass.Connectivity, reason: 'connection' });
  }, 10000);
});

describe('TrustedChannelIdentity', () => {
  it('resolves the trusted channel identity', async () => {
    expect(await new TrustedChannelIdentity().resolve()).toBe(TRUSTED_CHANNEL);
  });
});
