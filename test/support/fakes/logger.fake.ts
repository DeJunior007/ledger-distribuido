import { LoggerPort, type LogFields } from '@application/ports/logger.port';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

export class FakeLogger extends LoggerPort {
  private readonly recorded: LogEntry[] = [];

  get entries(): readonly LogEntry[] {
    return [...this.recorded];
  }

  entriesAt(level: LogLevel): readonly LogEntry[] {
    return this.recorded.filter((entry) => entry.level === level);
  }

  info(message: string, fields: LogFields = {}): void {
    this.recorded.push({ level: 'info', message, fields });
  }

  warn(message: string, fields: LogFields = {}): void {
    this.recorded.push({ level: 'warn', message, fields });
  }

  error(message: string, fields: LogFields = {}): void {
    this.recorded.push({ level: 'error', message, fields });
  }
}
