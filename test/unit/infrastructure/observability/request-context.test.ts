import { describe, expect, it } from 'bun:test';
import { requestContext } from '@infrastructure/observability/request-context';

describe('requestContext', () => {
  it('returns an empty context outside a run', () => {
    expect(requestContext.current()).toEqual({});
  });

  it('exposes the initial fields inside a run', async () => {
    const seen = await requestContext.run({ correlationId: 'corr-1', component: 'api' }, () =>
      Promise.resolve(requestContext.current()),
    );
    expect(seen).toEqual({ correlationId: 'corr-1', component: 'api' });
  });

  it('adds fields with enrich and keeps them across awaits', async () => {
    const seen = await requestContext.run({ correlationId: 'corr-2' }, async () => {
      requestContext.enrich({ walletId: 'wallet-1' });
      await Promise.resolve();
      requestContext.enrich({ transactionId: 'tx-1' });
      return requestContext.current();
    });
    expect(seen).toEqual({ correlationId: 'corr-2', walletId: 'wallet-1', transactionId: 'tx-1' });
  });

  it('isolates concurrent runs', async () => {
    const [first, second] = await Promise.all([
      requestContext.run({ messageId: 'm-1' }, async () => {
        await Promise.resolve();
        requestContext.enrich({ walletId: 'w-1' });
        return requestContext.current();
      }),
      requestContext.run({ messageId: 'm-2' }, () => Promise.resolve(requestContext.current())),
    ]);
    expect(first).toEqual({ messageId: 'm-1', walletId: 'w-1' });
    expect(second).toEqual({ messageId: 'm-2' });
  });

  it('ignores enrich outside a run', () => {
    requestContext.enrich({ walletId: 'w-1' });
    expect(requestContext.current()).toEqual({});
  });
});
