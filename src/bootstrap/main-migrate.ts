import { MikroORM } from '@mikro-orm/postgresql';
import { ErrorClass, TechnicalError } from '@application/errors/error-class';
import { loadConfig } from '@infrastructure/config/env.schema';
import { buildOrmOptions } from '@infrastructure/persistence/mikro-orm.config';

const CONNECT_DEADLINE_MS = 30_000;
const CONNECT_RETRY_DELAY_MS = 1_000;

type Direction = 'up' | 'down';

const directionFrom = (args: readonly string[]): Direction =>
  args.includes('--down') ? 'down' : 'up';

const describeFailure = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return 'unknown error';
  }
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' ? `${error.name} (${code})` : error.name;
};

const writeLine = (stream: NodeJS.WriteStream, line: string): void => {
  stream.write(`${line}\n`);
};

const connectWithRetry = async (
  connect: () => Promise<MikroORM>,
  deadline: number,
): Promise<MikroORM> => {
  for (;;) {
    try {
      return await connect();
    } catch (error) {
      if (Date.now() + CONNECT_RETRY_DELAY_MS > deadline) {
        throw error;
      }
      writeLine(process.stderr, `database not ready: ${describeFailure(error)}; retrying`);
      await Bun.sleep(CONNECT_RETRY_DELAY_MS);
    }
  }
};

const openOrm = async (options: ReturnType<typeof buildOrmOptions>): Promise<MikroORM> => {
  const orm = await MikroORM.init(options);
  const status = await orm.checkConnection();
  if (status.ok) {
    return orm;
  }
  await orm.close(true);
  throw new TechnicalError(ErrorClass.Connectivity, 'connection', { cause: status.error });
};

const runMigrations = async (direction: Direction): Promise<void> => {
  const config = loadConfig(process.env, { role: 'migrate' });
  const options = buildOrmOptions('migrator', config);
  const orm = await connectWithRetry(() => openOrm(options), Date.now() + CONNECT_DEADLINE_MS);
  try {
    const migrator = orm.migrator;
    const executed = direction === 'up' ? await migrator.up() : await migrator.down();
    const names = executed.map((migration) => migration.name);
    writeLine(
      process.stdout,
      `migrations ${direction}: ${names.length === 0 ? 'none' : names.join(', ')}`,
    );
  } finally {
    await orm.close(true);
  }
};

try {
  await runMigrations(directionFrom(process.argv.slice(2)));
} catch (error) {
  writeLine(process.stderr, `migration failed: ${describeFailure(error)}`);
  process.exitCode = 1;
}
