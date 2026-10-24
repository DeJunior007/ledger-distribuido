import { hostname } from 'node:os';
import { z } from 'zod';

export const configRoles = [
  'api',
  'consumer',
  'outbox',
  'scheduler',
  'events-audit',
  'migrate',
  'script',
] as const;

export type ConfigRole = (typeof configRoles)[number];

const integer = (fallback: number): z.ZodDefault<z.ZodNumber> =>
  z.coerce.number().int().default(fallback);

const positiveInteger = (fallback: number): z.ZodDefault<z.ZodNumber> =>
  z.coerce.number().int().positive().default(fallback);

const booleanFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const splitList = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

const currencyList = z
  .string()
  .default('BRL,USD,EUR')
  .transform(splitList)
  .pipe(z.array(z.string().regex(/^[A-Z]{3}$/)).min(1));

const faultPoints = z.string().default('').transform(splitList);

const envSchema = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  MIGRATION_DATABASE_URL: z.string().min(1).optional(),
  SQS_ENDPOINT: z.string().min(1).default('http://localhost:4566'),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().min(1).default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).default('test'),
  WAGER_QUEUE_NAME: z.string().min(1).default('wager-transactions.fifo'),
  WAGER_DLQ_NAME: z.string().min(1).default('wager-transactions-dlq.fifo'),
  EVENTS_QUEUE_NAME: z.string().min(1).default('wallet-events.fifo'),
  SUPPORTED_CURRENCIES: currencyList,
  HTTP_PORT: positiveInteger(3000),
  INSTANCE_ID: z
    .string()
    .min(1)
    .default(() => hostname()),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DB_LOCK_TIMEOUT_MS: positiveInteger(3000),
  DB_STATEMENT_TIMEOUT_MS: positiveInteger(5000),
  DB_TRANSACTION_TIMEOUT_MS: positiveInteger(15000),
  DB_CONNECT_TIMEOUT_MS: positiveInteger(2000),
  DB_QUERY_TIMEOUT_MS: positiveInteger(6000),
  DB_POOL_MAX: positiveInteger(20),
  RECONCILIATION_QUERY_TIMEOUT_MS: positiveInteger(65000),
  RECONCILIATION_POOL_MAX: positiveInteger(2),
  SQS_REQUEST_TIMEOUT_MS: positiveInteger(5000),
  SQS_RECEIVE_WAIT_SECONDS: integer(20).pipe(z.number().min(0).max(20)),
  CONSUMER_VISIBILITY_HEARTBEAT_MS: positiveInteger(10000),
  CONSUMER_VISIBILITY_TIMEOUT_SECONDS: positiveInteger(30),
  CONSUMER_MAX_RECEIVE_COUNT: positiveInteger(8),
  CONSUMER_PROCESSING_TIMEOUT_MS: positiveInteger(20000),
  OUTBOX_BATCH_SIZE: positiveInteger(50),
  OUTBOX_LEASE_MS: positiveInteger(30000),
  OUTBOX_IDLE_MS: positiveInteger(500),
  PENDING_BATCH_SIZE: positiveInteger(50),
  PENDING_LEASE_MS: positiveInteger(30000),
  PENDING_TTL_MS: positiveInteger(900000),
  PENDING_MAX_DETERMINISTIC_ERRORS: positiveInteger(5),
  RECONCILIATION_INTERVAL_MS: positiveInteger(300000),
  METRICS_SAMPLE_INTERVAL_MS: positiveInteger(10000),
  AUTH_ISSUER_URL: z.string().min(1).default('http://localhost:8081/realms/jungle'),
  AUTH_JWKS_URL: z
    .string()
    .min(1)
    .default('http://keycloak:8080/realms/jungle/protocol/openid-connect/certs'),
  AUTH_AUDIENCE: z.string().min(1).default('wagering-api'),
  OTEL_ENABLED: booleanFlag,
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().min(1).optional(),
  ENABLE_FAULT_INJECTION: booleanFlag,
  FAULT_POINTS: faultPoints,
});

export type AppConfig = z.infer<typeof envSchema>;

export interface LoadConfigOptions {
  readonly role: ConfigRole;
}

const withoutEmptyValues = (
  env: Record<string, string | undefined>,
): Record<string, string | undefined> =>
  Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ''),
  );

const requiredUrlVariable = (role: ConfigRole): 'DATABASE_URL' | 'MIGRATION_DATABASE_URL' =>
  role === 'migrate' ? 'MIGRATION_DATABASE_URL' : 'DATABASE_URL';

export const loadConfig = (
  env: Record<string, string | undefined>,
  options: LoadConfigOptions,
): AppConfig => {
  const required = requiredUrlVariable(options.role);
  const refined = envSchema.superRefine((value, context) => {
    if (value[required] === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [required],
        message: `${required} is required for role ${options.role}`,
      });
    }
    if (
      value.CONSUMER_VISIBILITY_HEARTBEAT_MS >=
      (value.CONSUMER_VISIBILITY_TIMEOUT_SECONDS * 1000) / 2
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CONSUMER_VISIBILITY_HEARTBEAT_MS'],
        message:
          'CONSUMER_VISIBILITY_HEARTBEAT_MS must be lower than CONSUMER_VISIBILITY_TIMEOUT_SECONDS * 1000 / 2',
      });
    }
  });
  const result = refined.safeParse(withoutEmptyValues(env));
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${details}`);
  }
  return result.data;
};
