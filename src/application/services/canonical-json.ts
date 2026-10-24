import { CanonicalJsonError } from './errors/canonical-json.error';

export type CanonicalValue =
  string | boolean | CanonicalValue[] | { [key: string]: CanonicalValue | undefined };

export function canonicalJson(value: CanonicalValue): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return `[${items.map(serialize).join(',')}]`;
  }
  if (isPlainObject(value)) {
    return serializeObject(value);
  }
  throw new CanonicalJsonError(describeType(value));
}

function serializeObject(value: Record<string, unknown>): string {
  const members = Object.keys(value)
    .sort()
    .flatMap((key) => {
      const member = value[key];
      return member === undefined ? [] : [`${JSON.stringify(key)}:${serialize(member)}`];
    });
  return `{${members.join(',')}}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function describeType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (value instanceof Date) {
    return 'Date';
  }
  return typeof value;
}
