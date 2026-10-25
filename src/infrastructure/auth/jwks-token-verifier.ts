import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import { UnauthenticatedError } from '@application/errors/unauthenticated.error';
import type { AppConfig } from '@infrastructure/config/env.schema';

export type JwksTokenVerifierConfig = Pick<
  AppConfig,
  'AUTH_ISSUER_URL' | 'AUTH_JWKS_URL' | 'AUTH_AUDIENCE'
>;

const JWKS_TIMEOUT_MS = 2000;
const JWKS_COOLDOWN_MS = 30000;
const JWKS_CACHE_MAX_AGE_MS = 600000;
const CLOCK_TOLERANCE_SECONDS = 30;
const ALLOWED_ALGORITHMS: readonly string[] = ['RS256'];
const REQUIRED_CLAIMS: readonly string[] = ['exp'];

const connectivityError = (cause: unknown): TechnicalError =>
  new TechnicalError(ErrorClass.Connectivity, 'connection', { cause });

export class JwksTokenVerifier {
  private readonly keys: JWTVerifyGetKey;

  constructor(private readonly config: JwksTokenVerifierConfig) {
    const remoteKeys = createRemoteJWKSet(new URL(config.AUTH_JWKS_URL), {
      timeoutDuration: JWKS_TIMEOUT_MS,
      cooldownDuration: JWKS_COOLDOWN_MS,
      cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
    });
    this.keys = async (protectedHeader, token) => {
      try {
        return await remoteKeys(protectedHeader, token);
      } catch (error: unknown) {
        throw error instanceof errors.JOSEError ? error : connectivityError(error);
      }
    };
  }

  async verify(token: string): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.config.AUTH_ISSUER_URL,
        audience: this.config.AUTH_AUDIENCE,
        algorithms: [...ALLOWED_ALGORITHMS],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: [...REQUIRED_CLAIMS],
      });
      return payload;
    } catch (error: unknown) {
      if (error instanceof errors.JWKSTimeout) {
        throw connectivityError(error);
      }
      if (error instanceof errors.JOSEError) {
        throw new UnauthenticatedError(`invalid token: ${error.code}`);
      }
      throw error;
    }
  }
}
