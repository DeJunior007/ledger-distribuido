import { HasherPort } from '@application/ports/hasher.port';

export class Sha256Hasher extends HasherPort {
  sha256Hex(input: string): string {
    return new Bun.CryptoHasher('sha256').update(input).digest('hex');
  }
}
