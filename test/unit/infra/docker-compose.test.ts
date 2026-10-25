import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

const POSTGRES_DEFAULT_MAX_CONNECTIONS = 100;
const POSTGRES_SUPERUSER_RESERVED_CONNECTIONS = 3;
const KEYCLOAK_DEFAULT_POOL_MAX = 100;
const APP_DEFAULT_POOL_MAX = 20;
const MIGRATOR_CONNECTIONS = 1;
const APP_SERVICES = ['api', 'consumer', 'outbox', 'scheduler', 'events-audit'] as const;

const environmentSchema = z.record(z.union([z.string(), z.number()])).default({});

const serviceSchema = z.object({
  command: z.union([z.string(), z.array(z.string())]).optional(),
  environment: environmentSchema,
  deploy: z.object({ replicas: z.number().int().positive() }).optional(),
});

const composeSchema = z.object({ services: z.record(serviceSchema) });

type ComposeService = z.infer<typeof serviceSchema>;

const loadCompose = async (): Promise<Record<string, ComposeService>> =>
  composeSchema.parse(Bun.YAML.parse(await Bun.file('docker-compose.yml').text())).services;

const loadEnvExample = async (): Promise<Map<string, string>> => {
  const text = await Bun.file('.env.example').text();
  const entries = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && line.includes('='))
    .map((line): [string, string] => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    });
  return new Map(entries);
};

const serviceOf = (services: Record<string, ComposeService>, name: string): ComposeService => {
  const service = services[name];
  expect(service).toBeDefined();
  return service ?? { environment: {} };
};

const integerOf = (value: string | number | undefined, fallback: number): number =>
  value === undefined ? fallback : Number.parseInt(String(value), 10);

const maxConnectionsOf = (postgres: ComposeService): number => {
  const command = Array.isArray(postgres.command)
    ? postgres.command.join(' ')
    : (postgres.command ?? '');
  const match = /max_connections=(\d+)/.exec(command);
  return match?.[1] === undefined
    ? POSTGRES_DEFAULT_MAX_CONNECTIONS
    : Number.parseInt(match[1], 10);
};

describe('docker-compose connection budget', () => {
  it('declares DB_POOL_MAX on every application service', async () => {
    const services = await loadCompose();
    for (const name of APP_SERVICES) {
      expect(serviceOf(services, name).environment.DB_POOL_MAX).toBeDefined();
    }
  });

  it('keeps every pool at full size below the postgres max_connections', async () => {
    const services = await loadCompose();
    const envExample = await loadEnvExample();
    const fallbackPool = integerOf(envExample.get('DB_POOL_MAX'), APP_DEFAULT_POOL_MAX);
    const reconciliationPool = integerOf(envExample.get('RECONCILIATION_POOL_MAX'), 2);
    const appConnections = APP_SERVICES.reduce((total, name) => {
      const service = serviceOf(services, name);
      const replicas = service.deploy?.replicas ?? 1;
      const pool = integerOf(service.environment.DB_POOL_MAX, fallbackPool);
      return total + replicas * (pool + reconciliationPool);
    }, 0);
    const keycloakPool = integerOf(
      serviceOf(services, 'keycloak').environment.KC_DB_POOL_MAX_SIZE,
      KEYCLOAK_DEFAULT_POOL_MAX,
    );
    const budget =
      appConnections +
      keycloakPool +
      MIGRATOR_CONNECTIONS +
      POSTGRES_SUPERUSER_RESERVED_CONNECTIONS;
    expect(budget).toBeLessThan(maxConnectionsOf(serviceOf(services, 'postgres')));
  });
});
