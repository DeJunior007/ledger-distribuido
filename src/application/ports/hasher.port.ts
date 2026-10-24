export abstract class HasherPort {
  abstract sha256Hex(input: string): string;
}
