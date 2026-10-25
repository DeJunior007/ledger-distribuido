import { Type } from '@mikro-orm/core';
import type { EntityProperty, Platform } from '@mikro-orm/core';

export class ExactDecimalType extends Type<string, string> {
  override convertToDatabaseValue(value: string): string {
    return value;
  }

  override convertToJSValue(value: string): string {
    return value;
  }

  override compareAsType(): string {
    return 'string';
  }

  override getColumnType(prop: EntityProperty, platform: Platform): string {
    return platform.getDecimalTypeDeclarationSQL(prop);
  }
}
