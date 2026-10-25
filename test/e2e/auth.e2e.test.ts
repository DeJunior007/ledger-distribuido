import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { decodeJwt } from 'jose';
import type { JWTPayload } from 'jose';
import { z } from 'zod';
import { TestIssuer } from '@test/support/test-issuer';

type KeycloakClient = 'provider-a' | 'provider-b' | 'backoffice';

const EXPECTED_ISSUER = 'http://localhost:8081/realms/jungle';
const HOST_TOKEN_URL = `${EXPECTED_ISSUER}/protocol/openid-connect/token`;
const NETWORK_TOKEN_URL = 'http://keycloak:8080/realms/jungle/protocol/openid-connect/token';
const API_URL = 'http://localhost:8080';
const AUDIENCE = 'wagering-api';
const REQUESTS_PER_TOKEN = 6;
const STARTING_BALANCE = { amount: '100.00', currency: 'BRL' } as const;

const tokenResponseSchema = z.object({ access_token: z.string().min(1) });
const createdWalletSchema = z.object({ id: z.string(), playerId: z.string() });
const walletViewSchema = z.object({ id: z.string(), balance: z.unknown() }).passthrough();
const realmAccessSchema = z.object({ roles: z.array(z.string()) });

const clientCredentials = (client: KeycloakClient): Record<string, string> => ({
  grant_type: 'client_credentials',
  client_id: client,
  client_secret: `${client}-secret`,
});

const hostToken = async (client: KeycloakClient): Promise<string> => {
  const response = await fetch(HOST_TOKEN_URL, {
    method: 'POST',
    body: new URLSearchParams(clientCredentials(client)),
  });
  expect(response.status).toBe(200);
  return tokenResponseSchema.parse(await response.json()).access_token;
};

const networkTokenScript = (client: KeycloakClient): string =>
  [
    `const response = await fetch(${JSON.stringify(NETWORK_TOKEN_URL)}, {`,
    `  method: 'POST',`,
    `  body: new URLSearchParams(${JSON.stringify(clientCredentials(client))}),`,
    `});`,
    `if (!response.ok) process.exit(1);`,
    `process.stdout.write((await response.json()).access_token);`,
  ].join('\n');

const networkToken = async (client: KeycloakClient): Promise<string> => {
  const child = Bun.spawn(
    ['docker', 'compose', 'exec', '-T', 'api', 'bun', '-e', networkTokenScript(client)],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(exitCode).toBe(0);
  return stdout.trim();
};

const authorized = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
});

const getWallet = (walletId: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${API_URL}/wallets/${walletId}`, { headers });

const postWallet = (headers: Record<string, string>): Promise<Response> =>
  fetch(`${API_URL}/wallets`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId: crypto.randomUUID(), initialBalance: STARTING_BALANCE }),
  });

const rolesOf = (claims: JWTPayload): string[] =>
  realmAccessSchema.parse(claims.realm_access).roles;

const audiencesOf = (claims: JWTPayload): string[] =>
  claims.aud === undefined ? [] : [claims.aud].flat();

const withAudience = (token: string, audience: string): string => {
  const [header, , signature] = token.split('.');
  const payload = Buffer.from(JSON.stringify({ ...decodeJwt(token), aud: audience }));
  return [header, payload.toString('base64url'), signature].join('.');
};

describe('keycloak tokens through nginx', () => {
  const tokens = {
    hostOperator: '',
    networkOperator: '',
    hostProvider: '',
    networkProvider: '',
  };
  let walletId = '';
  let walletCreationStatus = 0;

  beforeAll(async () => {
    [tokens.hostOperator, tokens.networkOperator, tokens.hostProvider, tokens.networkProvider] =
      await Promise.all([
        hostToken('backoffice'),
        networkToken('backoffice'),
        hostToken('provider-a'),
        networkToken('provider-a'),
      ]);
    const created = await postWallet(authorized(tokens.hostOperator));
    walletCreationStatus = created.status;
    walletId = createdWalletSchema.parse(await created.json()).id;
  });

  it('issues the same issuer to the host and to a container in the network', () => {
    const operatorFromHost = decodeJwt(tokens.hostOperator);
    const operatorFromNetwork = decodeJwt(tokens.networkOperator);
    const providerFromHost = decodeJwt(tokens.hostProvider);
    const providerFromNetwork = decodeJwt(tokens.networkProvider);

    for (const claims of [
      operatorFromHost,
      operatorFromNetwork,
      providerFromHost,
      providerFromNetwork,
    ]) {
      expect(claims.iss).toBe(EXPECTED_ISSUER);
      expect(audiencesOf(claims)).toContain(AUDIENCE);
    }
    expect(operatorFromNetwork.iss).toBe(operatorFromHost.iss ?? '');
    expect(providerFromNetwork.iss).toBe(providerFromHost.iss ?? '');
    expect(operatorFromHost.azp).toBe('backoffice');
    expect(rolesOf(operatorFromHost)).toContain('operator');
    expect(providerFromNetwork.azp).toBe('provider-a');
    expect(providerFromNetwork.provider_id).toBe('provider-a');
    expect(rolesOf(providerFromNetwork)).toContain('provider');
  });

  it('creates a wallet with the operator token and refuses the provider token', async () => {
    expect(walletCreationStatus).toBe(201);

    const asProvider = await postWallet(authorized(tokens.hostProvider));

    expect(asProvider.status).toBe(403);
  });

  it('accepts operator tokens from the host and from the network on every api replica', async () => {
    for (const token of [tokens.hostOperator, tokens.networkOperator]) {
      for (let attempt = 0; attempt < REQUESTS_PER_TOKEN; attempt += 1) {
        const response = await getWallet(walletId, authorized(token));
        expect(response.status).toBe(200);
        const wallet = walletViewSchema.parse(await response.json());
        expect(wallet.id).toBe(walletId);
        expect(wallet).toHaveProperty('playerId');
      }
    }
  });

  it('lets a provider read the wallet balance view', async () => {
    for (const token of [tokens.hostProvider, tokens.networkProvider]) {
      const response = await getWallet(walletId, authorized(token));
      expect(response.status).toBe(200);
      const wallet = walletViewSchema.parse(await response.json());
      expect(wallet.id).toBe(walletId);
      expect(wallet).not.toHaveProperty('playerId');
    }
  });

  describe('with tokens the api must refuse', () => {
    let foreignIssuer: TestIssuer | undefined;

    beforeAll(async () => {
      foreignIssuer = await TestIssuer.start();
    });

    afterAll(async () => {
      await foreignIssuer?.stop();
    });

    it('answers 401 without a token, with a tampered audience and with a foreign expired token', async () => {
      const expired = await foreignIssuer?.expired({ role: 'operator' });

      const responses = await Promise.all([
        getWallet(walletId),
        getWallet(walletId, authorized(withAudience(tokens.hostOperator, 'account'))),
        getWallet(walletId, authorized(expired ?? '')),
      ]);

      expect(responses.map((response) => response.status)).toEqual([401, 401, 401]);
    });
  });
});
