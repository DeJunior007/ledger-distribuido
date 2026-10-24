import { MikroORM } from '@mikro-orm/postgresql';
import type { AppConfig } from '@infrastructure/config/env.schema';
import { buildOrmOptions } from './mikro-orm.config';

export interface OrmInstances {
  readonly main: MikroORM;
  readonly reconciliation: MikroORM;
}

export const openOrmInstances = async (config: AppConfig): Promise<OrmInstances> => {
  const main = await MikroORM.init(buildOrmOptions('main', config));
  try {
    const reconciliation = await MikroORM.init(buildOrmOptions('reconciliation', config));
    return { main, reconciliation };
  } catch (error) {
    await main.close(true);
    throw error;
  }
};

export const closeOrmInstances = async (instances: OrmInstances): Promise<void> => {
  await Promise.all([instances.main.close(true), instances.reconciliation.close(true)]);
};
