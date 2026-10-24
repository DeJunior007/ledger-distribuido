import { Migrator } from '@mikro-orm/migrations';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import type { Options } from '@mikro-orm/postgresql';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import type { AppConfig } from '@infrastructure/config/env.schema';
import { ENTITY_SCHEMAS } from './schemas';

export type OrmKind = 'main' | 'reconciliation' | 'migrator';

const MIGRATOR_POOL_MAX = 1;

const IDLE_IN_TRANSACTION_OPTIONS = '-c idle_in_transaction_session_timeout=20000';

interface ConnectionTuning {
  readonly clientUrl: string;
  readonly poolMax: number;
  readonly queryTimeoutMs: number | undefined;
}

const requireUrl = (url: string | undefined): string => {
  if (url === undefined) {
    throw new TechnicalError(ErrorClass.Deterministic, 'deterministic');
  }
  return url;
};

const connectionOptions = (
  config: AppConfig,
  queryTimeoutMs: number | undefined,
): Record<string, unknown> => {
  const base = {
    connectionTimeoutMillis: config.DB_CONNECT_TIMEOUT_MS,
    keepAlive: true,
    options: IDLE_IN_TRANSACTION_OPTIONS,
  };
  return queryTimeoutMs === undefined ? base : { ...base, query_timeout: queryTimeoutMs };
};

const baseOptions = (config: AppConfig, tuning: ConnectionTuning): Options => ({
  driver: PostgreSqlDriver,
  clientUrl: tuning.clientUrl,
  entities: ENTITY_SCHEMAS,
  debug: false,
  forceUtcTimezone: true,
  allowGlobalContext: false,
  pool: { min: 0, max: tuning.poolMax, acquireTimeoutMillis: config.DB_CONNECT_TIMEOUT_MS },
  driverOptions: { connection: connectionOptions(config, tuning.queryTimeoutMs) },
  migrations: {
    path: 'src/infrastructure/persistence/migrations',
    glob: 'Migration*.ts',
    transactional: true,
    allOrNothing: true,
    snapshot: false,
  },
});

const buildMainOptions = (config: AppConfig): Options =>
  baseOptions(config, {
    clientUrl: requireUrl(config.DATABASE_URL),
    poolMax: config.DB_POOL_MAX,
    queryTimeoutMs: config.DB_QUERY_TIMEOUT_MS,
  });

const buildReconciliationOptions = (config: AppConfig): Options =>
  baseOptions(config, {
    clientUrl: requireUrl(config.DATABASE_URL),
    poolMax: config.RECONCILIATION_POOL_MAX,
    queryTimeoutMs: config.RECONCILIATION_QUERY_TIMEOUT_MS,
  });

const buildMigratorOptions = (config: AppConfig): Options => ({
  ...baseOptions(config, {
    clientUrl: requireUrl(config.MIGRATION_DATABASE_URL),
    poolMax: MIGRATOR_POOL_MAX,
    queryTimeoutMs: undefined,
  }),
  extensions: [Migrator],
  discovery: { warnWhenNoEntities: false },
});

const BUILDERS: Readonly<Record<OrmKind, (config: AppConfig) => Options>> = {
  main: buildMainOptions,
  reconciliation: buildReconciliationOptions,
  migrator: buildMigratorOptions,
};

export const buildOrmOptions = (kind: OrmKind, config: AppConfig): Options =>
  BUILDERS[kind](config);
