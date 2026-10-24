export class CanonicalJsonError extends Error {
  constructor(readonly valueType: string) {
    super(`canonical json does not accept a value of type ${valueType}`);
    this.name = 'CanonicalJsonError';
  }
}
