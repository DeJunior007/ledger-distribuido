export interface ScheduledJobRecordProps {
  name: string;
  lockedUntil: Date | null;
  lockedBy: string | null;
  lastRunAt: Date | null;
}

export class ScheduledJobRecord {
  name: string;
  lockedUntil: Date | null;
  lockedBy: string | null;
  lastRunAt: Date | null;

  constructor(props: ScheduledJobRecordProps) {
    this.name = props.name;
    this.lockedUntil = props.lockedUntil;
    this.lockedBy = props.lockedBy;
    this.lastRunAt = props.lastRunAt;
  }
}
