export abstract class ScheduledJobRepositoryPort {
  abstract tryAcquire(
    name: string,
    instanceId: string,
    leaseMs: number,
    minIntervalMs: number,
  ): Promise<boolean>;
  abstract complete(name: string, instanceId: string, at: Date): Promise<void>;
}
