import { describe, expect, it } from 'bun:test';
import { Uuidv7IdGenerator } from '@infrastructure/system/uuidv7-id-generator';

const uuidv7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('Uuidv7IdGenerator', () => {
  it('generates valid UUIDv7 values', () => {
    const generator = new Uuidv7IdGenerator();
    expect(generator.next()).toMatch(uuidv7Pattern);
  });

  it('generates ids that grow over time', async () => {
    const generator = new Uuidv7IdGenerator();
    const first = generator.next();
    await Bun.sleep(5);
    const second = generator.next();
    await Bun.sleep(5);
    const third = generator.next();
    expect(first < second).toBe(true);
    expect(second < third).toBe(true);
  });
});
