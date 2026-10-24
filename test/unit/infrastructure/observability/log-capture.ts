import type { DestinationStream } from 'pino';

export interface LogCapture {
  readonly destination: DestinationStream;
  readonly lines: string[];
  readonly entries: () => Record<string, unknown>[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const captureLogs = (): LogCapture => {
  const lines: string[] = [];
  return {
    destination: {
      write(chunk: string) {
        lines.push(chunk);
      },
    },
    lines,
    entries: () =>
      lines.map((line) => {
        const parsed: unknown = JSON.parse(line);
        return isRecord(parsed) ? parsed : {};
      }),
  };
};
