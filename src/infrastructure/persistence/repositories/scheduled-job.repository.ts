import type { EntityManager } from '@mikro-orm/postgresql';
import type { ScheduledJobRepositoryPort } from '@application/ports/repositories/scheduled-job-repository.port';
import { parseScheduledJobAcquiredRows } from '../rows/scheduled-jobs.row';

const TRY_ACQUIRE_SQL = `UPDATE scheduled_jobs
SET locked_until = now() + (? * interval '1 millisecond'), locked_by = ?
WHERE name = ?
  AND (locked_until IS NULL OR locked_until < now())
  AND (last_run_at IS NULL OR last_run_at <= now() - (? * interval '1 millisecond'))
RETURNING name`;

const COMPLETE_SQL = `UPDATE scheduled_jobs SET last_run_at = ?, locked_until = NULL, locked_by = NULL WHERE name = ? AND locked_by = ?`;

export class MikroOrmScheduledJobRepository implements ScheduledJobRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async tryAcquire(
    name: string,
    instanceId: string,
    leaseMs: number,
    minIntervalMs: number,
  ): Promise<boolean> {
    const rows = await this.em.execute(TRY_ACQUIRE_SQL, [leaseMs, instanceId, name, minIntervalMs]);
    return parseScheduledJobAcquiredRows(rows) > 0;
  }

  async complete(name: string, instanceId: string, at: Date): Promise<void> {
    await this.em.execute(COMPLETE_SQL, [at, name, instanceId], 'run');
  }
}
