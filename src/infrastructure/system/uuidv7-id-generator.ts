import { IdGeneratorPort } from '@application/ports/id-generator.port';

export class Uuidv7IdGenerator extends IdGeneratorPort {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
