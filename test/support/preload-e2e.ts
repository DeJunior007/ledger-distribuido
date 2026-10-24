import { afterEach } from 'bun:test';
import { ledgerConsistencyAfterEach } from './ledger-consistency';

const COMPOSE_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/jungle';

afterEach(ledgerConsistencyAfterEach(COMPOSE_DATABASE_URL));
