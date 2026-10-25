import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Client } from 'pg';
import { z } from 'zod';

const DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/jungle';
const PROVIDER_ID = 'provider-a';
const WALLETS = 2;
const COUNT = 3;
const SCENARIOS = ['duplicates', 'out-of-order', 'concurrent', 'mixed'] as const;
const SIMULATION_TIMEOUT_MS = 180_000;

const runIdPattern = /^provider simulate: scenario=\S+ run=(\S+)$/m;
const transactionsPattern = /^ {2}published=\d+ transactions=(\d+) unsettled=0 queueDrained=true$/m;
const reconciliationPattern = /^reconciliation: (\d+)\/(\d+) consistent \((\d+)%\)$/m;

const storedTransactionSchema = z.object({
  externalId: z.string(),
  kind: z.string(),
  status: z.string(),
  walletLegs: z.number(),
  houseLegs: z.number(),
});

interface SimulatorRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const simulate = async (args: readonly string[]): Promise<SimulatorRun> => {
  const child = Bun.spawn(['bun', 'run', 'provider:simulate', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const STORED_SQL = `SELECT t.external_transaction_id AS "externalId", t.kind, t.status,
       count(e.id) FILTER (WHERE e.account_kind = 'WALLET')::int AS "walletLegs",
       count(e.id) FILTER (WHERE e.account_kind = 'HOUSE')::int AS "houseLegs"
FROM wager_transactions t
LEFT JOIN ledger_entries e ON e.transaction_id = t.id
WHERE t.provider_id = $1 AND t.external_transaction_id LIKE $2
GROUP BY t.id
ORDER BY t.external_transaction_id`;

describe('provider simulator against the compose stack', () => {
  const database = new Client({ connectionString: DATABASE_URL });

  beforeAll(async () => {
    await database.connect();
  });

  afterAll(async () => {
    await database.end();
  });

  for (const scenario of SCENARIOS) {
    it(
      `runs the ${scenario} scenario to a fully consistent summary`,
      async () => {
        const result = await simulate([
          '--scenario',
          scenario,
          '--wallets',
          String(WALLETS),
          '--count',
          String(COUNT),
        ]);

        expect({
          exitCode: result.exitCode,
          output: result.exitCode === 0 ? '' : `${result.stdout}${result.stderr}`,
        }).toEqual({ exitCode: 0, output: '' });
        expect(result.stdout).toContain('result: OK');
        const reconciliation = reconciliationPattern.exec(result.stdout);
        expect(reconciliation?.slice(1)).toEqual([String(WALLETS), String(WALLETS), '100']);
        const runId = runIdPattern.exec(result.stdout)?.[1] ?? '';
        expect(runId).not.toBe('');

        const stored = await database.query(STORED_SQL, [PROVIDER_ID, `sim-${runId}-%`]);
        const transactions = stored.rows.map((row) => storedTransactionSchema.parse(row));
        const expectedTransactions = Number(transactionsPattern.exec(result.stdout)?.[1] ?? '0');
        expect(expectedTransactions).toBeGreaterThan(0);
        expect(transactions).toHaveLength(expectedTransactions);
        expect(transactions.filter((row) => row.status === 'PENDING_REFERENCE')).toEqual([]);
        for (const row of transactions) {
          const posted = row.status === 'PROCESSED' && row.kind !== 'LOSS';
          expect(row).toEqual({
            externalId: row.externalId,
            kind: row.kind,
            status: 'PROCESSED',
            walletLegs: posted ? 1 : 0,
            houseLegs: posted ? 1 : 0,
          });
        }
      },
      { timeout: SIMULATION_TIMEOUT_MS },
    );
  }

  it('exits 1 for an unknown scenario', async () => {
    const result = await simulate(['--scenario', 'bogus', '--wallets', '2', '--count', '3']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--scenario must be one of');
  });
});
