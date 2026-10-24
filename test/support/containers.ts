import type { StartedTestContainer } from 'testcontainers';
import { waitFor } from './wait-for';

export type ContainerName = 'postgres' | 'ministack';

type DockerAction = 'pause' | 'unpause';

const STATE_WAIT = { timeoutMs: 10_000, intervalMs: 100 } as const;

const EXPECTED_STATE: Readonly<Record<DockerAction, string>> = {
  pause: 'paused',
  unpause: 'running',
};

const started = new Map<ContainerName, StartedTestContainer>();

export class DockerCommandError extends Error {
  constructor(args: readonly string[], exitCode: number, stderr: string) {
    super(`docker ${args.join(' ')} exited with ${String(exitCode)}: ${stderr.trim()}`);
    this.name = 'DockerCommandError';
  }
}

export class ContainerNotStartedError extends Error {
  constructor(name: ContainerName) {
    super(`container ${name} was not started by the preload`);
    this.name = 'ContainerNotStartedError';
  }
}

export const registerContainer = (name: ContainerName, container: StartedTestContainer): void => {
  started.set(name, container);
};

const containerFor = (name: ContainerName): StartedTestContainer => {
  const container = started.get(name);
  if (container === undefined) {
    throw new ContainerNotStartedError(name);
  }
  return container;
};

const runDocker = async (args: readonly string[]): Promise<string> => {
  const child = Bun.spawn(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new DockerCommandError(args, exitCode, stderr);
  }
  return stdout.trim();
};

const stateOf = (container: StartedTestContainer): Promise<string> =>
  runDocker(['inspect', '-f', '{{.State.Status}}', container.getId()]);

export const containerState = (name: ContainerName): Promise<string> => stateOf(containerFor(name));

const switchState = async (action: DockerAction, name: ContainerName): Promise<void> => {
  const container = containerFor(name);
  await runDocker([action, container.getId()]);
  await waitFor(async () => (await stateOf(container)) === EXPECTED_STATE[action], STATE_WAIT);
};

export const pause = (name: ContainerName): Promise<void> => switchState('pause', name);

export const unpause = (name: ContainerName): Promise<void> => switchState('unpause', name);

const stopContainer = async (container: StartedTestContainer): Promise<void> => {
  if ((await stateOf(container)) === EXPECTED_STATE.pause) {
    await runDocker(['unpause', container.getId()]);
  }
  await container.stop();
};

export const stopContainers = async (): Promise<void> => {
  const containers = [...started.values()];
  started.clear();
  await Promise.all(containers.map(stopContainer));
};
