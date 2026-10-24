import { ScheduledJobRepositoryPort } from '@application/ports/repositories/scheduled-job-repository.port';
import { compositeKey } from './in-memory-unit-of-work.fake';
import type { FakeTransaction } from './in-memory-unit-of-work.fake';

export class InMemoryScheduledJobRepository extends ScheduledJobRepositoryPort {
  constructor(private readonly transaction: FakeTransaction) {
    super();
  }

  async tryAcquire(
    name: string,
    instanceId: string,
    leaseMs: number,
    minIntervalMs: number,
  ): Promise<boolean> {
    await this.lockRow(name);
    const row = this.transaction.scheduledJobs.find(name);
    if (row === undefined) {
      return false;
    }
    const now = this.transaction.database.clock.now();
    const leaseFree = row.lockedUntil === undefined || row.lockedUntil.getTime() < now.getTime();
    const intervalElapsed =
      row.lastRunAt === undefined || row.lastRunAt.getTime() <= now.getTime() - minIntervalMs;
    if (!leaseFree || !intervalElapsed) {
      return false;
    }
    this.transaction.scheduledJobs.update({
      ...row,
      lockedUntil: new Date(now.getTime() + leaseMs),
      lockedBy: instanceId,
    });
    return true;
  }

  async complete(name: string, instanceId: string, at: Date): Promise<void> {
    await this.lockRow(name);
    const row = this.transaction.scheduledJobs.find(name);
    if (row?.lockedBy !== instanceId) {
      return;
    }
    this.transaction.scheduledJobs.update({
      ...row,
      lastRunAt: at,
      lockedUntil: undefined,
      lockedBy: undefined,
    });
  }

  private async lockRow(name: string): Promise<void> {
    await this.transaction.database.locks.acquire(
      compositeKey('scheduled_jobs', name),
      this.transaction.id,
    );
  }
}
