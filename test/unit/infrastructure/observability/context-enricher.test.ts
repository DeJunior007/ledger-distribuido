import { describe, expect, it } from 'bun:test';
import { contextEnricher } from '@infrastructure/observability/context-enricher';
import { requestContext } from '@infrastructure/observability/request-context';

describe('contextEnricher', () => {
  it('adds the ids to the current request context', async () => {
    const seen = await requestContext.run({ correlationId: 'corr-1' }, () => {
      contextEnricher({ transactionId: 'tx-1', walletId: 'w-1', providerId: 'p-1' });
      return Promise.resolve(requestContext.current());
    });
    expect(seen).toEqual({
      correlationId: 'corr-1',
      transactionId: 'tx-1',
      walletId: 'w-1',
      providerId: 'p-1',
    });
  });
});
