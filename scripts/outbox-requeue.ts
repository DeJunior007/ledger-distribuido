import type { AppConfig } from '@infrastructure/config/env.schema';
import { loadConfig } from '@infrastructure/config/env.schema';
import { MikroOrmUnitOfWork } from '@infrastructure/persistence/mikro-orm-unit-of-work';
import { closeOrmInstances, openOrmInstances } from '@infrastructure/persistence/orm-instances';

const describeFailure = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return 'unknown error';
  }
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' ? `${error.name} (${code})` : error.name;
};

export const requeueParkedOutbox = async (config: AppConfig): Promise<number> => {
  const orm = await openOrmInstances(config);
  try {
    const unitOfWork = new MikroOrmUnitOfWork(orm, config);
    return await unitOfWork.run('short', (repos) => repos.outbox.requeueParked(undefined));
  } finally {
    await closeOrmInstances(orm);
  }
};

export const formatRequeueSummary = (requeued: number): string =>
  `outbox requeue: requeued=${String(requeued)}`;

if (import.meta.main) {
  try {
    const requeued = await requeueParkedOutbox(loadConfig(process.env, { role: 'script' }));
    console.log(formatRequeueSummary(requeued));
  } catch (error) {
    console.error(`outbox requeue failed: ${describeFailure(error)}`);
    process.exitCode = 1;
  }
}
