import type { Logger } from 'pino';
import { LoggerPort, type LogFields } from '@application/ports/logger.port';

export class PinoLoggerAdapter extends LoggerPort {
  constructor(private readonly logger: Logger) {
    super();
  }

  info(message: string, fields?: LogFields): void {
    this.logger.info({ ...fields }, message);
  }

  warn(message: string, fields?: LogFields): void {
    this.logger.warn({ ...fields }, message);
  }

  error(message: string, fields?: LogFields): void {
    this.logger.error({ ...fields }, message);
  }
}
