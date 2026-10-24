import type { ContextEnricher } from '@application/ports/context-enricher';
import { requestContext } from './request-context';

export const contextEnricher: ContextEnricher = (fields) => {
  requestContext.enrich(fields);
};
