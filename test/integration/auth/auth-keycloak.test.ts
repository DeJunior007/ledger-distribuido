import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { decodeJwt } from 'jose';
import type { JWTPayload } from 'jose';
import { Client } from 'pg';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { z } from 'zod';
import {
  betCommand,
  createWalletViaApi,
  submitViaApi,
  walletRequest,
} from '@test/support/fixtures';
import type { TestWallet } from '@test/support/fixtures';
import { createTestApp } from '@test/support/test-app';
import type { TestApp } from '@test/support/test-app';
import { createTestDatabase } from '@test/support/test-database';
import type { TestDatabase } from '@test/support/test-database';

type KeycloakClient = 'provider-a' | 'provider-b' | 'backoffice';

const KEYCLOAK_IMAGE = 'quay.io/keycloak/keycloak:26.8.1';
const KEYCLOAK_HTTP_PORT = 8080;
const KEYCLOAK_MANAGEMENT_PORT = 9000;
const KEYCLOAK_STARTUP_TIMEOUT_MS = 180_000;
const REALM_FILE = resolve(import.meta.dir, '../../../infra/keycloak/realm-jungle.json');
const REALM_IMPORT_TARGET = '/opt/keycloak/data/import/realm-jungle.json';
const AUDIENCE = 'wagering-api';

const discoverySchema = z.object({ issuer: z.string().url(), jwks_uri: z.string().url() });
const tokenResponseSchema = z.object({ access_token: z.string().min(1) });
const realmAccessSchema = z.object({ roles: z.array(z.string()) });
const walletViewSchema = z.object({ id: z.string() }).passthrough();
const transactionResultSchema = z.object({ transactionId: z.string(), status: z.string() });

class ApiNotRunningError extends Error {
  constructor() {
    super('the api under test is not running');
    this.name = 'ApiNotRunningError';
  }
}

let keycloak: StartedTestContainer | undefined;
let database: TestDatabase;
let app: TestApp | undefined;
let issuer = '';
let wallet: TestWallet;
const tokens: Record<KeycloakClient, string> = {
  'provider-a': '',
  'provider-b': '',
  backoffice: '',
};

const startKeycloak = (): Promise<StartedTestContainer> =>
  new GenericContainer(KEYCLOAK_IMAGE)
    .withCommand(['start-dev', '--import-realm'])
    .withEnvironment({
      KC_BOOTSTRAP_ADMIN_USERNAME: 'admin',
      KC_BOOTSTRAP_ADMIN_PASSWORD: 'admin',
      KC_HEALTH_ENABLED: 'true',
    })
    .withCopyFilesToContainer([{ source: REALM_FILE, target: REALM_IMPORT_TARGET }])
    .withExposedPorts(KEYCLOAK_HTTP_PORT, KEYCLOAK_MANAGEMENT_PORT)
    .withWaitStrategy(Wait.forHttp('/health/ready', KEYCLOAK_MANAGEMENT_PORT).forStatusCode(200))
    .withStartupTimeout(KEYCLOAK_STARTUP_TIMEOUT_MS)
    .start();

const realmUrlOf = (container: StartedTestContainer): string =>
  `http://${container.getHost()}:${String(container.getMappedPort(KEYCLOAK_HTTP_PORT))}/realms/jungle`;

const discover = async (realmUrl: string): Promise<z.infer<typeof discoverySchema>> => {
  const response = await fetch(`${realmUrl}/.well-known/openid-configuration`);
  expect(response.status).toBe(200);
  return discoverySchema.parse(await response.json());
};

const clientCredentialsToken = async (
  tokenUrl: string,
  client: KeycloakClient,
): Promise<string> => {
  const response = await fetch(tokenUrl, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: client,
      client_secret: `${client}-secret`,
    }),
  });
  expect(response.status).toBe(200);
  return tokenResponseSchema.parse(await response.json()).access_token;
};

const runningApp = (): TestApp => {
  if (app === undefined) {
    throw new ApiNotRunningError();
  }
  return app;
};

const authorized = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
});

const getWallet = (walletId: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${runningApp().baseUrl}/wallets/${walletId}`, { headers });

const postWallet = (headers: Record<string, string>): Promise<Response> =>
  fetch(`${runningApp().baseUrl}/wallets`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(walletRequest()),
  });

const rolesOf = (claims: JWTPayload): string[] =>
  realmAccessSchema.parse(claims.realm_access).roles;

const audiencesOf = (claims: JWTPayload): string[] =>
  claims.aud === undefined ? [] : [claims.aud].flat();

const storedProviderOf = async (transactionId: string): Promise<string | undefined> => {
  const client = new Client({ connectionString: database.superuserUrl });
  await client.connect();
  try {
    const result = await client.query<{ provider_id: string }>(
      'select provider_id from wager_transactions where id = $1',
      [transactionId],
    );
    return result.rows[0]?.provider_id;
  } finally {
    await client.end();
  }
};

const countTransactions = async (): Promise<number> => {
  const client = new Client({ connectionString: database.superuserUrl });
  await client.connect();
  try {
    const result = await client.query<{ total: number }>(
      'select count(*)::int as total from wager_transactions',
    );
    return result.rows[0]?.total ?? 0;
  } finally {
    await client.end();
  }
};

beforeAll(async () => {
  keycloak = await startKeycloak();
  const discovery = await discover(realmUrlOf(keycloak));
  issuer = discovery.issuer;
  const tokenUrl = `${issuer}/protocol/openid-connect/token`;
  database = await createTestDatabase();
  app = await createTestApp({
    roles: ['api'],
    env: {
      DATABASE_URL: database.appUrl,
      AUTH_ISSUER_URL: issuer,
      AUTH_JWKS_URL: discovery.jwks_uri,
      AUTH_AUDIENCE: AUDIENCE,
    },
  });
  [tokens['provider-a'], tokens['provider-b'], tokens.backoffice] = await Promise.all([
    clientCredentialsToken(tokenUrl, 'provider-a'),
    clientCredentialsToken(tokenUrl, 'provider-b'),
    clientCredentialsToken(tokenUrl, 'backoffice'),
  ]);
  wallet = await createWalletViaApi(app.baseUrl, tokens.backoffice);
}, KEYCLOAK_STARTUP_TIMEOUT_MS);

afterAll(async () => {
  await app?.stop();
  await keycloak?.stop();
});

describe('client credentials against a real keycloak', () => {
  it('reads an issuer bound to the mapped port and configures the api with it', () => {
    expect(issuer).toEndWith('/realms/jungle');
    expect(new URL(issuer).port).toBe(String(keycloak?.getMappedPort(KEYCLOAK_HTTP_PORT)));
    expect(runningApp().config.AUTH_ISSUER_URL).toBe(issuer);
  });

  it('issues tokens with the discovered issuer, the api audience, roles and provider_id', () => {
    const operator = decodeJwt(tokens.backoffice);
    const providerA = decodeJwt(tokens['provider-a']);
    const providerB = decodeJwt(tokens['provider-b']);

    for (const claims of [operator, providerA, providerB]) {
      expect(claims.iss).toBe(issuer);
      expect(audiencesOf(claims)).toContain(AUDIENCE);
    }
    expect(operator.azp).toBe('backoffice');
    expect(rolesOf(operator)).toContain('operator');
    expect(rolesOf(operator)).not.toContain('provider');
    expect(operator.provider_id).toBeUndefined();
    expect(providerA.azp).toBe('provider-a');
    expect(providerA.provider_id).toBe('provider-a');
    expect(rolesOf(providerA)).toContain('provider');
    expect(rolesOf(providerA)).not.toContain('operator');
    expect(providerB.azp).toBe('provider-b');
    expect(providerB.provider_id).toBe('provider-b');
    expect(rolesOf(providerB)).toContain('provider');
  });

  it('creates a wallet with the backoffice token and refuses it to a provider', async () => {
    const asOperator = await postWallet(authorized(tokens.backoffice));
    const asProvider = await postWallet(authorized(tokens['provider-a']));

    expect(asOperator.status).toBe(201);
    expect(asProvider.status).toBe(403);
  });

  it('lets the three clients read the wallet', async () => {
    for (const client of ['backoffice', 'provider-a', 'provider-b'] as const) {
      const response = await getWallet(wallet.id, authorized(tokens[client]));
      expect(response.status).toBe(200);
      expect(walletViewSchema.parse(await response.json()).id).toBe(wallet.id);
    }
  });

  it('records the provider_id of the token on a submitted transaction', async () => {
    const response = await submitViaApi(
      runningApp().baseUrl,
      tokens['provider-a'],
      betCommand({ wallet, providerId: 'provider-a' }),
    );

    expect(response.status).toBe(200);
    const result = transactionResultSchema.parse(await response.json());
    expect(result.status).toBe('PROCESSED');
    expect(await storedProviderOf(result.transactionId)).toBe('provider-a');
  });

  it('refuses a transaction whose providerId differs from the token without writing it', async () => {
    const before = await countTransactions();

    const response = await submitViaApi(
      runningApp().baseUrl,
      tokens['provider-b'],
      betCommand({ wallet, providerId: 'provider-a' }),
    );

    expect(response.status).toBe(403);
    expect(await countTransactions()).toBe(before);
  });

  it('answers 401 without a token and with a token from another issuer', async () => {
    const foreign = await runningApp().issuer.token({ role: 'operator' });

    const responses = await Promise.all([
      getWallet(wallet.id),
      getWallet(wallet.id, authorized(foreign)),
    ]);

    expect(responses.map((response) => response.status)).toEqual([401, 401]);
  });
});
