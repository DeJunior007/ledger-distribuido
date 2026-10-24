import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  correlationId: string;
  requestId: string;
  messageId: string;
  transactionId: string;
  walletId: string;
  providerId: string;
  instanceId: string;
  component: string;
}

const storage = new AsyncLocalStorage<Partial<RequestContext>>();

export const requestContext = {
  run<T>(initial: Partial<RequestContext>, fn: () => Promise<T>): Promise<T> {
    return storage.run({ ...storage.getStore(), ...initial }, fn);
  },
  enrich(fields: Partial<RequestContext>): void {
    const store = storage.getStore();
    if (store !== undefined) {
      Object.assign(store, fields);
    }
  },
  current(): Readonly<Partial<RequestContext>> {
    return { ...storage.getStore() };
  },
};
