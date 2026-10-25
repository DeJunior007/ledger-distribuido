import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { CryptoKey, JWK, JWTPayload } from 'jose';

export const TEST_AUDIENCE = 'wagering-api';
export const TEST_REALM_PATH = '/realms/jungle';
export const TEST_JWKS_PATH = '/certs';
export const TEST_TOKEN_LIFETIME_SECONDS = 300;
export const TEST_OPERATOR_CLIENT_ID = 'backoffice';
export const TEST_PROVIDER_ID = 'provider-a';

const KEY_ID = 'jungle-test-key';
const ALGORITHM = 'RS256';
const DEFAULT_REALM_ROLE = 'default-roles-jungle';
const OTHER_ISSUER_PATH = '/realms/other';
const OTHER_AUDIENCE = 'account';
const EXPIRED_SECONDS_AGO = 120;

export interface ProviderTokenRequest {
  readonly role: 'provider';
  readonly providerId: string;
  readonly clientId?: string;
  readonly expiresInSeconds?: number;
  readonly claims?: JWTPayload;
}

export interface OperatorTokenRequest {
  readonly role: 'operator';
  readonly clientId?: string;
  readonly expiresInSeconds?: number;
  readonly claims?: JWTPayload;
}

export type TestTokenRequest = ProviderTokenRequest | OperatorTokenRequest;

export interface TestAuthConfig {
  readonly AUTH_ISSUER_URL: string;
  readonly AUTH_JWKS_URL: string;
  readonly AUTH_AUDIENCE: string;
}

interface SigningOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly expiresAt: number;
  readonly key: CryptoKey;
}

const DEFAULT_PROVIDER_REQUEST: ProviderTokenRequest = {
  role: 'provider',
  providerId: TEST_PROVIDER_ID,
};

const nowInSeconds = (): number => Math.floor(Date.now() / 1000);

const claimsOf = (request: TestTokenRequest): JWTPayload => {
  const base: JWTPayload =
    request.role === 'provider'
      ? {
          azp: request.clientId ?? request.providerId,
          realm_access: { roles: [request.role, DEFAULT_REALM_ROLE] },
          provider_id: request.providerId,
        }
      : {
          azp: request.clientId ?? TEST_OPERATOR_CLIENT_ID,
          realm_access: { roles: [request.role, DEFAULT_REALM_ROLE] },
        };
  return { ...base, ...request.claims };
};

export class TestIssuer {
  private constructor(
    private readonly server: ReturnType<typeof Bun.serve>,
    private readonly signingKey: CryptoKey,
    private readonly foreignKey: CryptoKey,
  ) {}

  static async start(): Promise<TestIssuer> {
    const signing = await generateKeyPair(ALGORITHM);
    const foreign = await generateKeyPair(ALGORITHM);
    const publicJwk: JWK = { ...(await exportJWK(signing.publicKey)), kid: KEY_ID, alg: ALGORITHM };
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname === TEST_JWKS_PATH
          ? Response.json({ keys: [publicJwk] })
          : new Response(null, { status: 404 }),
    });
    return new TestIssuer(server, signing.privateKey, foreign.privateKey);
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${String(this.server.port)}`;
  }

  get issuer(): string {
    return `${this.baseUrl}${TEST_REALM_PATH}`;
  }

  get jwksUrl(): string {
    return `${this.baseUrl}${TEST_JWKS_PATH}`;
  }

  get audience(): string {
    return TEST_AUDIENCE;
  }

  get authConfig(): TestAuthConfig {
    return {
      AUTH_ISSUER_URL: this.issuer,
      AUTH_JWKS_URL: this.jwksUrl,
      AUTH_AUDIENCE: this.audience,
    };
  }

  token(request: TestTokenRequest): Promise<string> {
    return this.sign(claimsOf(request), {
      expiresAt: nowInSeconds() + (request.expiresInSeconds ?? TEST_TOKEN_LIFETIME_SECONDS),
    });
  }

  expired(request: TestTokenRequest = DEFAULT_PROVIDER_REQUEST): Promise<string> {
    return this.sign(claimsOf(request), { expiresAt: nowInSeconds() - EXPIRED_SECONDS_AGO });
  }

  wrongIssuer(request: TestTokenRequest = DEFAULT_PROVIDER_REQUEST): Promise<string> {
    return this.sign(claimsOf(request), { issuer: `${this.baseUrl}${OTHER_ISSUER_PATH}` });
  }

  wrongAudience(request: TestTokenRequest = DEFAULT_PROVIDER_REQUEST): Promise<string> {
    return this.sign(claimsOf(request), { audience: OTHER_AUDIENCE });
  }

  wrongSignature(request: TestTokenRequest = DEFAULT_PROVIDER_REQUEST): Promise<string> {
    return this.sign(claimsOf(request), { key: this.foreignKey });
  }

  noRoles(clientId: string = TEST_PROVIDER_ID): Promise<string> {
    return this.sign({ azp: clientId, provider_id: clientId, realm_access: { roles: [] } });
  }

  providerWithoutProviderId(clientId: string = TEST_PROVIDER_ID): Promise<string> {
    return this.sign({ azp: clientId, realm_access: { roles: ['provider', DEFAULT_REALM_ROLE] } });
  }

  async stop(): Promise<void> {
    await this.server.stop(true);
  }

  private sign(claims: JWTPayload, overrides: Partial<SigningOptions> = {}): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: ALGORITHM, kid: KEY_ID, typ: 'JWT' })
      .setIssuer(overrides.issuer ?? this.issuer)
      .setAudience(overrides.audience ?? this.audience)
      .setIssuedAt()
      .setExpirationTime(overrides.expiresAt ?? nowInSeconds() + TEST_TOKEN_LIFETIME_SECONDS)
      .sign(overrides.key ?? this.signingKey);
  }
}
