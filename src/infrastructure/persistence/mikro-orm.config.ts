import { Migrator } from '@mikro-orm/migrations';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import type { Options } from '@mikro-orm/postgresql';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import type { AppConfig } from '@infrastructure/config/env.schema';

export type OrmKind = 'migrator';

const MIGRATOR_POOL_MAX = 1;

const requireMigrationUrl = (config: AppConfig): string => {
  if (config.MIGRATION_DATABASE_URL === undefined) {
    throw new TechnicalError(ErrorClass.Deterministic, 'deterministic');
  }
  return config.MIGRATION_DATABASE_URL;
};

const buildMigratorOptions = (config: AppConfig): Options => ({
  driver: PostgreSqlDriver,
  clientUrl: requireMigrationUrl(config),
  entities: [],
  debug: false,
  forceUtcTimezone: true,
  allowGlobalContext: false,
  extensions: [Migrator],
  discovery: { warnWhenNoEntities: false },
  pool: { min: 0, max: MIGRATOR_POOL_MAX, acquireTimeoutMillis: config.DB_CONNECT_TIMEOUT_MS },
  driverOptions: {
    connection: {
      connectionTimeoutMillis: config.DB_CONNECT_TIMEOUT_MS,
      keepAlive: true,
      options: '-c idle_in_transaction_session_timeout=20000',
    },
  },
  migrations: {
    path: 'src/infrastructure/persistence/migrations',
    glob: 'Migration*.ts',
    transactional: true,
    allOrNothing: true,
    snapshot: false,
  },
});

const BUILDERS: Readonly<Record<OrmKind, (config: AppConfig) => Options>> = {
  migrator: buildMigratorOptions,
};

export const buildOrmOptions = (kind: OrmKind, config: AppConfig): Options =>
  BUILDERS[kind](config);
