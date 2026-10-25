import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { IncomingHttpHeaders } from 'node:http';
import type { ExecutionContext, Type } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { ForbiddenError } from '@application/errors/forbidden.error';
import { UnauthenticatedError } from '@application/errors/unauthenticated.error';
import { JwksTokenVerifier } from '@infrastructure/auth/jwks-token-verifier';
import { JwtProviderIdentityAdapter } from '@infrastructure/auth/jwt-provider-identity.adapter';
import { requestContext } from '@infrastructure/observability/request-context';
import { AuthGuard } from '@interfaces/http/auth.guard';
import {
  currentIdentityOf,
  type IdentityCarrier,
} from '@interfaces/http/current-identity.decorator';
import { Public } from '@interfaces/http/public.decorator';
import { Roles } from '@interfaces/http/roles.decorator';
import { TestIssuer } from '@test/support/test-issuer';

class ProbeRoutes {
  @Roles('provider')
  providerOnly(): void {
    return undefined;
  }

  @Roles('operator')
  operatorOnly(): void {
    return undefined;
  }

  @Roles('provider', 'operator')
  anyRole(): void {
    return undefined;
  }

  @Public()
  open(): void {
    return undefined;
  }

  withoutRoles(): void {
    return undefined;
  }
}

@Public()
class PublicRoutes {
  health(): void {
    return undefined;
  }
}

type Handler = ReturnType<ExecutionContext['getHandler']>;

const handlerOf = (prototype: object, name: string): Handler => {
  const handler: unknown = Reflect.get(prototype, name);
  if (typeof handler !== 'function') {
    throw new TypeError(`probe handler ${name} does not exist`);
  }
  return handler;
};

const route = (name: keyof ProbeRoutes): Handler => handlerOf(ProbeRoutes.prototype, name);

const requestWith = (headers: IncomingHttpHeaders = {}): IdentityCarrier => ({ headers });

const contextFor = (
  request: IdentityCarrier,
  handler: Handler,
  controller: Type = ProbeRoutes,
): ExecutionContextHost => new ExecutionContextHost([request, {}], controller, handler);

const bearer = (token: string): IncomingHttpHeaders => ({ authorization: `Bearer ${token}` });

const captureFailure = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );

describe('AuthGuard', () => {
  let issuer: TestIssuer;
  let guard: AuthGuard;

  const activate = (request: IdentityCarrier, handler: Handler): Promise<boolean> =>
    guard.canActivate(contextFor(request, handler));

  beforeAll(async () => {
    issuer = await TestIssuer.start();
    guard = new AuthGuard(
      new Reflector(),
      new JwtProviderIdentityAdapter(new JwksTokenVerifier(issuer.authConfig)),
    );
  });

  afterAll(async () => {
    await issuer.stop();
  });

  it('lets a public route through without a token', async () => {
    expect(await activate(requestWith(), route('open'))).toBe(true);
  });

  it('lets a route of a public controller through without a token', async () => {
    const context = contextFor(
      requestWith(),
      handlerOf(PublicRoutes.prototype, 'health'),
      PublicRoutes,
    );

    expect(await guard.canActivate(context)).toBe(true);
  });

  it('rejects a request without the Authorization header', async () => {
    const failure = await captureFailure(activate(requestWith(), route('providerOnly')));

    expect(failure).toBeInstanceOf(UnauthenticatedError);
  });

  it.each([
    ['another scheme', 'Basic cHJvdmlkZXItYTpzZWNyZXQ='],
    ['a scheme without token', 'Bearer'],
    ['an empty token', 'Bearer '],
    ['a token with spaces', 'Bearer abc def'],
    ['a lowercase scheme', 'bearer abc'],
  ])('rejects an Authorization header with %s', async (_case, authorization) => {
    const failure = await captureFailure(
      activate(requestWith({ authorization }), route('providerOnly')),
    );

    expect(failure).toBeInstanceOf(UnauthenticatedError);
  });

  it.each([
    ['expired', (): Promise<string> => issuer.expired()],
    ['from another issuer', (): Promise<string> => issuer.wrongIssuer()],
    ['for another audience', (): Promise<string> => issuer.wrongAudience()],
    ['signed by another key', (): Promise<string> => issuer.wrongSignature()],
  ])('rejects a token %s with UnauthenticatedError', async (_case, tokenOf) => {
    const failure = await captureFailure(
      activate(requestWith(bearer(await tokenOf())), route('anyRole')),
    );

    expect(failure).toBeInstanceOf(UnauthenticatedError);
  });

  it.each([
    ['without roles', (): Promise<string> => issuer.noRoles()],
    [
      'of a provider without provider_id',
      (): Promise<string> => issuer.providerWithoutProviderId(),
    ],
  ])('rejects a token %s with ForbiddenError', async (_case, tokenOf) => {
    const failure = await captureFailure(
      activate(requestWith(bearer(await tokenOf())), route('anyRole')),
    );

    expect(failure).toBeInstanceOf(ForbiddenError);
  });

  it('rejects an operator on a provider only route', async () => {
    const token = await issuer.token({ role: 'operator' });

    const failure = await captureFailure(
      activate(requestWith(bearer(token)), route('providerOnly')),
    );

    expect(failure).toBeInstanceOf(ForbiddenError);
  });

  it('rejects a provider on an operator only route', async () => {
    const token = await issuer.token({ role: 'provider', providerId: 'provider-b' });

    const failure = await captureFailure(
      activate(requestWith(bearer(token)), route('operatorOnly')),
    );

    expect(failure).toBeInstanceOf(ForbiddenError);
  });

  it('rejects any identity on a route without @Roles', async () => {
    const token = await issuer.token({ role: 'operator' });

    const failure = await captureFailure(
      activate(requestWith(bearer(token)), route('withoutRoles')),
    );

    expect(failure).toBeInstanceOf(ForbiddenError);
  });

  it('exposes the provider identity and adds providerId to the log context', async () => {
    const token = await issuer.token({ role: 'provider', providerId: 'provider-b' });
    const request = requestWith(bearer(token));
    const context = contextFor(request, route('providerOnly'));

    const logContext = await requestContext.run(
      { requestId: 'request-1', correlationId: 'correlation-1', component: 'api' },
      async () => {
        expect(await guard.canActivate(context)).toBe(true);
        return requestContext.current();
      },
    );

    expect(currentIdentityOf(context)).toEqual({
      kind: 'provider',
      providerId: 'provider-b',
      clientId: 'provider-b',
    });
    expect(logContext).toEqual({
      requestId: 'request-1',
      correlationId: 'correlation-1',
      component: 'api',
      providerId: 'provider-b',
    });
  });

  it('exposes the operator identity without a providerId in the log context', async () => {
    const token = await issuer.token({ role: 'operator' });
    const request = requestWith(bearer(token));
    const context = contextFor(request, route('anyRole'));

    const logContext = await requestContext.run({ requestId: 'request-2' }, async () => {
      expect(await guard.canActivate(context)).toBe(true);
      return requestContext.current();
    });

    expect(currentIdentityOf(context)).toEqual({ kind: 'operator', clientId: 'backoffice' });
    expect(logContext).toEqual({ requestId: 'request-2' });
  });

  it('honours custom claims and client ids from the test issuer', async () => {
    const token = await issuer.token({
      role: 'provider',
      providerId: 'provider-a',
      clientId: 'provider-a-batch',
      claims: { realm_access: { roles: ['provider', 'operator'] } },
    });
    const context = contextFor(requestWith(bearer(token)), route('operatorOnly'));

    expect(await guard.canActivate(context)).toBe(true);
    expect(currentIdentityOf(context)).toEqual({
      kind: 'operator',
      clientId: 'provider-a-batch',
    });
  });

  it('fails closed when no identity was attached to the request', () => {
    const context = contextFor(requestWith(), route('open'));

    expect(() => currentIdentityOf(context)).toThrow(UnauthenticatedError);
  });
});
