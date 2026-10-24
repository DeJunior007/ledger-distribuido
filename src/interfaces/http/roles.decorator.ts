import { SetMetadata, type CustomDecorator } from '@nestjs/common';
import type { Identity } from '@application/ports/provider-identity.port';

export type IdentityKind = Identity['kind'];

export const ROLES_KEY = 'roles';

export const Roles = (...kinds: IdentityKind[]): CustomDecorator => SetMetadata(ROLES_KEY, kinds);
