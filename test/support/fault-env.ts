import type { FaultPoint } from '@application/ports/fault-injector.port';

export type FaultEnv = Readonly<Record<'ENABLE_FAULT_INJECTION' | 'FAULT_POINTS', string>>;

export const FAULT_KILL_EXIT_CODE = 137;

export const NO_FAULT_ENV: FaultEnv = { ENABLE_FAULT_INJECTION: 'false', FAULT_POINTS: '' };

export const faultEnv = (point: FaultPoint, ...morePoints: readonly FaultPoint[]): FaultEnv => ({
  ENABLE_FAULT_INJECTION: 'true',
  FAULT_POINTS: [point, ...morePoints].join(','),
});
