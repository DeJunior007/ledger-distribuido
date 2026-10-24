export type ReadinessProbe = () => Promise<void>;

export interface ReadinessProbes {
  readonly database: ReadinessProbe;
  readonly queue: ReadinessProbe;
}

export type CheckStatus = 'up' | 'down';

export interface ReadinessReport {
  readonly status: 'ok' | 'unavailable';
  readonly checks: {
    readonly database: CheckStatus;
    readonly queue: CheckStatus;
  };
}

export const READINESS_PROBE_TIMEOUT_MS = 1000;

const runProbe = async (probe: ReadinessProbe): Promise<CheckStatus> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<CheckStatus>((resolve) => {
    timer = setTimeout(() => {
      resolve('down');
    }, READINESS_PROBE_TIMEOUT_MS);
  });
  const settled = Promise.resolve()
    .then(probe)
    .then(
      (): CheckStatus => 'up',
      (): CheckStatus => 'down',
    );
  try {
    return await Promise.race([settled, expired]);
  } finally {
    clearTimeout(timer);
  }
};

export class ReadinessService {
  constructor(private readonly probes: ReadinessProbes) {}

  async check(): Promise<ReadinessReport> {
    const [database, queue] = await Promise.all([
      runProbe(this.probes.database),
      runProbe(this.probes.queue),
    ]);
    const ready = database === 'up' && queue === 'up';
    return { status: ready ? 'ok' : 'unavailable', checks: { database, queue } };
  }
}
