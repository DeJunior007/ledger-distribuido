import { EntitySchema } from '@mikro-orm/core';
import { ScheduledJobRecord } from '../records/scheduled-jobs.record';

export const ScheduledJobEntitySchema = new EntitySchema<ScheduledJobRecord>({
  class: ScheduledJobRecord,
  tableName: 'scheduled_jobs',
  properties: {
    name: { type: 'text', fieldName: 'name', primary: true },
    lockedUntil: {
      type: 'datetime',
      columnType: 'timestamptz',
      fieldName: 'locked_until',
      nullable: true,
    },
    lockedBy: { type: 'text', fieldName: 'locked_by', nullable: true },
    lastRunAt: {
      type: 'datetime',
      columnType: 'timestamptz',
      fieldName: 'last_run_at',
      nullable: true,
    },
  },
});
