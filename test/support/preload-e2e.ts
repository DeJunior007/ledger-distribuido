import { afterEach } from 'bun:test';
import { afterEachDatabaseCheck, noConsistencyCheck } from './current-database';

const COMPOSE_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/jungle';

afterEach(afterEachDatabaseCheck(noConsistencyCheck, COMPOSE_DATABASE_URL));
