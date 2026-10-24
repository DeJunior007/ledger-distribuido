import { describe, expect, it } from 'bun:test';
import { EnvFaultInjector } from '@infrastructure/system/env-fault-injector';

const injectorModule = new URL(
  '../../../../src/infrastructure/system/env-fault-injector.ts',
  import.meta.url,
).pathname;

const spawnHit = async (env: Record<string, string>, point: string): Promise<number | null> => {
  const script = `import { EnvFaultInjector } from ${JSON.stringify(injectorModule)}; new EnvFaultInjector().hit(${JSON.stringify(point)}); process.exit(0);`;
  const child = Bun.spawn([process.execPath, '-e', script], {
    env: { PATH: process.env.PATH ?? '', ...env },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  await child.exited;
  return child.signalCode === null ? child.exitCode : null;
};

describe('EnvFaultInjector', () => {
  it('does nothing at an inactive point', () => {
    const injector = new EnvFaultInjector({
      ENABLE_FAULT_INJECTION: 'true',
      FAULT_POINTS: 'api.before_commit',
    });
    expect(() => {
      injector.hit('consumer.before_commit');
    }).not.toThrow();
  });

  it('does nothing when injection is disabled', () => {
    const injector = new EnvFaultInjector({
      ENABLE_FAULT_INJECTION: 'false',
      FAULT_POINTS: 'api.before_commit',
    });
    expect(() => {
      injector.hit('api.before_commit');
    }).not.toThrow();
  });

  it('kills the process with SIGKILL at an active point', async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `import { EnvFaultInjector } from ${JSON.stringify(injectorModule)}; new EnvFaultInjector().hit('api.before_commit'); process.exit(0);`,
      ],
      {
        env: {
          PATH: process.env.PATH ?? '',
          ENABLE_FAULT_INJECTION: 'true',
          FAULT_POINTS: 'api.before_commit',
        },
        stdout: 'ignore',
        stderr: 'ignore',
      },
    );
    await child.exited;
    expect(child.signalCode).toBe('SIGKILL');
  });

  it('exits normally in a child process at an inactive point', async () => {
    const code = await spawnHit(
      { ENABLE_FAULT_INJECTION: 'true', FAULT_POINTS: 'api.before_commit' },
      'consumer.before_commit',
    );
    expect(code).toBe(0);
  });
});
