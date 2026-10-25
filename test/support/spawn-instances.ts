import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { TEST_APP_CONFIG } from './test-app';
import { WaitForTimeoutError, waitFor } from './wait-for';

export const instanceRoles = ['api', 'consumer', 'outbox', 'scheduler', 'events-audit'] as const;

export type InstanceRole = (typeof instanceRoles)[number];

export type InstanceSignal = 'SIGKILL' | 'SIGTERM' | 'SIGINT';

export type InstanceEnv = Readonly<Record<string, string | undefined>>;

export type LogEntry = Readonly<Record<string, unknown>>;

export const SIGKILL_EXIT_CODE = 137;
export const SIGTERM_EXIT_CODE = 143;
export const DEFAULT_READY_TIMEOUT_MS = 60_000;
export const DEFAULT_EXIT_TIMEOUT_MS = 30_000;
export const DEFAULT_LOG_TIMEOUT_MS = 30_000;
export const STOP_GRACE_MS = 20_000;

export interface SpawnInstancesOptions {
  readonly role: InstanceRole;
  readonly count: number;
  readonly env: InstanceEnv;
  readonly readyTimeoutMs?: number;
}

export interface RestartOptions {
  readonly env?: InstanceEnv;
}

export interface WaitForLogOptions {
  readonly timeoutMs?: number;
  readonly fromLine?: number;
}

export interface SpawnedInstance {
  readonly role: InstanceRole;
  readonly index: number;
  readonly instanceId: string;
  readonly port: number;
  readonly baseUrl: string;
  readonly pid: number;
  readonly running: boolean;
  readonly exitCode: number | undefined;
  stdoutLines(): readonly string[];
  stderrLines(): readonly string[];
  logs(): readonly LogEntry[];
  waitForLog(
    predicate: (entry: LogEntry) => boolean,
    options?: WaitForLogOptions,
  ): Promise<LogEntry>;
  waitForExit(timeoutMs?: number): Promise<number>;
  kill(signal?: InstanceSignal, timeoutMs?: number): Promise<number>;
  restart(options?: RestartOptions): Promise<void>;
}

export interface SpawnedInstances {
  readonly role: InstanceRole;
  readonly instances: readonly SpawnedInstance[];
  instance(index: number): SpawnedInstance;
  stop(): Promise<void>;
}

export class SpawnInstancesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpawnInstancesError';
  }
}

type ChildProcess = Subprocess<'ignore', 'pipe', 'pipe'>;

interface Run {
  readonly child: ChildProcess;
  readonly exited: Promise<number>;
  exitCode(): number | undefined;
}

interface InstanceSettings {
  readonly role: InstanceRole;
  readonly index: number;
  readonly instanceId: string;
  readonly port: number;
  readonly entryPoint: string;
  readonly env: Readonly<Record<string, string>>;
  readonly readyTimeoutMs: number;
}

const REPO_ROOT = join(import.meta.dir, '..', '..');
const POLL_INTERVAL_MS = 100;
const READY_REQUEST_TIMEOUT_MS = 1000;
const TAIL_LINE_COUNT = 20;
const PORT_ATTEMPTS_PER_INSTANCE = 10;
const INHERITED_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG'] as const;
const REQUIRED_ENV = [
  'DATABASE_URL',
  'SQS_ENDPOINT',
  'WAGER_QUEUE_NAME',
  'WAGER_DLQ_NAME',
  'EVENTS_QUEUE_NAME',
] as const;
const REQUIRED_API_ENV = ['AUTH_ISSUER_URL', 'AUTH_JWKS_URL'] as const;

const reservedPorts = new Set<number>();
const liveChildren = new Set<ChildProcess>();

process.on('exit', () => {
  for (const child of liveChildren) {
    child.kill('SIGKILL');
  }
});

const entryPointFor = (role: InstanceRole): string =>
  join(REPO_ROOT, 'src', 'bootstrap', `main-${role}.ts`);

const definedEntries = (env: InstanceEnv): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

const inheritedEnv = (): InstanceEnv =>
  Object.fromEntries(INHERITED_ENV.map((name) => [name, process.env[name]]));

const isPresent = (value: string | undefined): boolean => value !== undefined && value !== '';

const requireEnv = (role: InstanceRole, env: InstanceEnv): void => {
  const required = role === 'api' ? [...REQUIRED_ENV, ...REQUIRED_API_ENV] : [...REQUIRED_ENV];
  const missing = required.filter((name) => !isPresent(env[name]));
  if (missing.length > 0) {
    throw new SpawnInstancesError(`spawnInstances(${role}) needs ${missing.join(', ')} in env`);
  }
};

const requireCount = (count: number): void => {
  if (!Number.isInteger(count) || count < 1) {
    throw new SpawnInstancesError(
      `spawnInstances needs a positive integer count, got ${String(count)}`,
    );
  }
};

const allocatePorts = async (count: number): Promise<number[]> => {
  const servers: ReturnType<typeof Bun.serve>[] = [];
  const ports: number[] = [];
  try {
    for (let attempt = 0; ports.length < count; attempt += 1) {
      if (attempt >= count * PORT_ATTEMPTS_PER_INSTANCE) {
        throw new SpawnInstancesError(`could not reserve ${String(count)} free ports`);
      }
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: () => new Response(null, { status: 404 }),
      });
      servers.push(server);
      const port = server.port;
      if (port !== undefined && !reservedPorts.has(port)) {
        reservedPorts.add(port);
        ports.push(port);
      }
    }
    return ports;
  } catch (error) {
    for (const port of ports) {
      reservedPorts.delete(port);
    }
    throw error;
  } finally {
    await Promise.all(servers.map((server) => server.stop(true)));
  }
};

const collectLines = async (stream: ReadableStream<Uint8Array>, sink: string[]): Promise<void> => {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let pending = '';
  const flush = (text: string): void => {
    const trimmed = text.trimEnd();
    if (trimmed.length > 0) {
      sink.push(trimmed);
    }
  };
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    pending += decoder.decode(chunk.value, { stream: true });
    const parts = pending.split('\n');
    pending = parts.pop() ?? '';
    parts.forEach(flush);
  }
  flush(pending + decoder.decode());
};

const isLogEntry = (value: unknown): value is LogEntry =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseLogLine = (line: string): LogEntry | undefined => {
  try {
    const parsed: unknown = JSON.parse(line);
    return isLogEntry(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const parseLogLines = (lines: readonly string[]): LogEntry[] =>
  lines.map(parseLogLine).filter((entry): entry is LogEntry => entry !== undefined);

const isReady = async (url: string): Promise<boolean> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(READY_REQUEST_TIMEOUT_MS) });
    await response.arrayBuffer();
    return response.status === 200;
  } catch {
    return false;
  }
};

class ManagedInstance implements SpawnedInstance {
  readonly role: InstanceRole;
  readonly index: number;
  readonly instanceId: string;
  readonly port: number;
  readonly baseUrl: string;
  private readonly entryPoint: string;
  private readonly readyTimeoutMs: number;
  private readonly stdout: string[] = [];
  private readonly stderr: string[] = [];
  private env: Readonly<Record<string, string>>;
  private current: Run;

  constructor(settings: InstanceSettings) {
    this.role = settings.role;
    this.index = settings.index;
    this.instanceId = settings.instanceId;
    this.port = settings.port;
    this.baseUrl = `http://127.0.0.1:${String(settings.port)}`;
    this.entryPoint = settings.entryPoint;
    this.readyTimeoutMs = settings.readyTimeoutMs;
    this.env = settings.env;
    this.current = this.launch();
  }

  get pid(): number {
    return this.current.child.pid;
  }

  get running(): boolean {
    return this.current.exitCode() === undefined;
  }

  get exitCode(): number | undefined {
    return this.current.exitCode();
  }

  stdoutLines(): readonly string[] {
    return [...this.stdout];
  }

  stderrLines(): readonly string[] {
    return [...this.stderr];
  }

  logs(): readonly LogEntry[] {
    return parseLogLines(this.stdout);
  }

  async waitForLog(
    predicate: (entry: LogEntry) => boolean,
    options: WaitForLogOptions = {},
  ): Promise<LogEntry> {
    const matches: LogEntry[] = [];
    const fromLine = options.fromLine ?? 0;
    await this.within(
      () => {
        const found = parseLogLines(this.stdout.slice(fromLine)).find(predicate);
        if (found !== undefined) {
          matches.push(found);
        }
        return found !== undefined;
      },
      options.timeoutMs ?? DEFAULT_LOG_TIMEOUT_MS,
      'no matching log entry',
    );
    const [entry] = matches;
    if (entry === undefined) {
      throw new SpawnInstancesError(`${this.instanceId}: no matching log entry`);
    }
    return entry;
  }

  async waitForExit(timeoutMs: number = DEFAULT_EXIT_TIMEOUT_MS): Promise<number> {
    const run = this.current;
    await this.within(() => run.exitCode() !== undefined, timeoutMs, 'process did not exit');
    return run.exited;
  }

  async kill(
    signal: InstanceSignal = 'SIGKILL',
    timeoutMs: number = DEFAULT_EXIT_TIMEOUT_MS,
  ): Promise<number> {
    if (this.running) {
      this.current.child.kill(signal);
    }
    return this.waitForExit(timeoutMs);
  }

  async restart(options: RestartOptions = {}): Promise<void> {
    await this.kill('SIGKILL');
    this.env = definedEntries({
      ...this.env,
      ...options.env,
      INSTANCE_ID: this.instanceId,
      HTTP_PORT: String(this.port),
    });
    this.current = this.launch();
    await this.waitUntilReady();
  }

  async waitUntilReady(): Promise<void> {
    const run = this.current;
    const readyUrl = `${this.baseUrl}/health/ready`;
    try {
      await this.within(
        async () => {
          const exitCode = run.exitCode();
          if (exitCode !== undefined) {
            throw new SpawnInstancesError(
              `${this.instanceId} exited with ${String(exitCode)} before it was ready${this.tail()}`,
            );
          }
          return isReady(readyUrl);
        },
        this.readyTimeoutMs,
        `${readyUrl} did not answer 200`,
      );
    } catch (error) {
      if (run.exitCode() === undefined) {
        run.child.kill('SIGKILL');
        await run.exited;
      }
      throw error;
    }
  }

  async terminate(): Promise<void> {
    if (!this.running) {
      return;
    }
    try {
      await this.kill('SIGTERM', STOP_GRACE_MS);
    } catch (error) {
      if (!(error instanceof SpawnInstancesError)) {
        throw error;
      }
      await this.kill('SIGKILL');
    }
  }

  private launch(): Run {
    const child = Bun.spawn([process.execPath, '--no-env-file', this.entryPoint], {
      cwd: REPO_ROOT,
      env: this.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    liveChildren.add(child);
    let exitCode: number | undefined;
    const drained = Promise.all([
      collectLines(child.stdout, this.stdout),
      collectLines(child.stderr, this.stderr),
    ]);
    const exited = Promise.all([child.exited, drained]).then(([code]) => {
      liveChildren.delete(child);
      exitCode = code;
      return code;
    });
    return { child, exited, exitCode: () => exitCode };
  }

  private async within(
    check: () => boolean | Promise<boolean>,
    timeoutMs: number,
    failure: string,
  ): Promise<void> {
    try {
      await waitFor(check, { timeoutMs, intervalMs: POLL_INTERVAL_MS });
    } catch (error) {
      if (error instanceof WaitForTimeoutError) {
        throw new SpawnInstancesError(
          `${this.instanceId}: ${failure} within ${String(timeoutMs)} ms${this.tail()}`,
        );
      }
      throw error;
    }
  }

  private tail(): string {
    const lines = [...this.stdout, ...this.stderr].slice(-TAIL_LINE_COUNT);
    return lines.length === 0 ? '' : `\n${lines.join('\n')}`;
  }
}

class InstanceGroup implements SpawnedInstances {
  constructor(
    readonly role: InstanceRole,
    private readonly managed: readonly ManagedInstance[],
  ) {}

  get instances(): readonly SpawnedInstance[] {
    return this.managed;
  }

  instance(index: number): SpawnedInstance {
    const found = this.managed[index];
    if (found === undefined) {
      throw new SpawnInstancesError(
        `${this.role} has ${String(this.managed.length)} instances, no index ${String(index)}`,
      );
    }
    return found;
  }

  async stop(): Promise<void> {
    try {
      await Promise.all(this.managed.map((instance) => instance.terminate()));
    } finally {
      for (const instance of this.managed) {
        reservedPorts.delete(instance.port);
      }
    }
  }
}

const childEnvFor = (
  env: InstanceEnv,
  instanceId: string,
  port: number,
): Readonly<Record<string, string>> =>
  definedEntries({
    ...inheritedEnv(),
    ...TEST_APP_CONFIG,
    LOG_LEVEL: 'info',
    ...env,
    INSTANCE_ID: instanceId,
    HTTP_PORT: String(port),
  });

const instanceIdFor = (role: InstanceRole, index: number): string =>
  `${role}-${String(index + 1)}-${randomUUID().slice(0, 8)}`;

export const spawnInstances = async (options: SpawnInstancesOptions): Promise<SpawnedInstances> => {
  requireCount(options.count);
  requireEnv(options.role, options.env);
  const entryPoint = entryPointFor(options.role);
  if (!(await Bun.file(entryPoint).exists())) {
    throw new SpawnInstancesError(`role ${options.role} has no entry point at ${entryPoint}`);
  }
  const ports = await allocatePorts(options.count);
  const managed = ports.map((port, index) => {
    const instanceId = instanceIdFor(options.role, index);
    return new ManagedInstance({
      role: options.role,
      index,
      instanceId,
      port,
      entryPoint,
      env: childEnvFor(options.env, instanceId, port),
      readyTimeoutMs: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    });
  });
  const group = new InstanceGroup(options.role, managed);
  const results = await Promise.allSettled(managed.map((instance) => instance.waitUntilReady()));
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure !== undefined) {
    await group.stop();
    throw failure.reason;
  }
  return group;
};
