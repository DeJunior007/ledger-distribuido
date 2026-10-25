import http from 'k6/http';
import exec from 'k6/execution';
import { SharedArray } from 'k6/data';
import { Counter, Trend } from 'k6/metrics';

const env = globalThis.__ENV;

const DURATION = env.DURATION || '60s';
const API_URL = env.API_URL || 'http://nginx';
const TOKEN_URL =
  env.TOKEN_URL || 'http://keycloak:8080/realms/jungle/protocol/openid-connect/token';
const CLIENT_ID = env.CLIENT_ID || 'provider-a';
const CLIENT_SECRET = env.CLIENT_SECRET || 'provider-a-secret';
const PROVIDER_ID = env.PROVIDER_ID || 'provider-a';
const RUN_ID = env.RUN_ID || String(Date.now());
const WALLETS_FILE = env.WALLETS_FILE || '/input/wallets.json';
const SUMMARY_START = '<<<k6-summary>>>';
const SUMMARY_END = '<<<end-k6-summary>>>';
const BET_AMOUNT = '0.01';
const TOKEN_REFRESH_MARGIN_MS = 30000;
const REQUEST_TIMEOUT = '30s';
const TRACKED_STATUSES = [0, 200, 202, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504];

const wallets = new SharedArray('wallets', () => JSON.parse(globalThis.open(WALLETS_FILE)));

const requestDuration = new Trend('wager_request_duration', true);
const statusCounters = new Map(
  TRACKED_STATUSES.map((status) => [status, new Counter(`wager_status_${String(status)}`)]),
);
const otherStatusCounter = new Counter('wager_status_other');

export const options = {
  scenarios: {
    hot_wallet: { executor: 'constant-vus', vus: 50, duration: DURATION },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(95)', 'p(99)', 'count'],
};

let token = '';
let tokenExpiresAt = 0;

const bearer = () => {
  if (token === '' || Date.now() >= tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) {
    const response = http.post(
      TOKEN_URL,
      { grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET },
      { tags: { name: 'token' }, timeout: REQUEST_TIMEOUT },
    );
    if (response.status !== 200) {
      exec.test.abort(`token endpoint answered HTTP ${String(response.status)}`);
    }
    const body = response.json();
    token = body.access_token;
    tokenExpiresAt = Date.now() + body.expires_in * 1000;
  }
  return `Bearer ${token}`;
};

const record = (response) => {
  requestDuration.add(response.timings.duration);
  const counter = statusCounters.get(response.status);
  if (counter === undefined) {
    otherStatusCounter.add(1);
  } else {
    counter.add(1);
  }
};

export default function hotWalletBet() {
  const wallet = wallets[0];
  const externalTransactionId = `load-${RUN_ID}-hot-${String(exec.vu.idInTest)}-${String(exec.vu.iterationInScenario)}`;
  const body = {
    providerId: PROVIDER_ID,
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: externalTransactionId,
    gameId: 'load-hot-wallet',
    kind: 'BET',
    money: { amount: BET_AMOUNT, currency: wallet.currency },
  };
  const response = http.post(`${API_URL}/wagering/transactions`, JSON.stringify(body), {
    headers: {
      Authorization: bearer(),
      'Content-Type': 'application/json',
      'Idempotency-Key': `idem-${externalTransactionId}`,
      'X-Correlation-Id': RUN_ID,
    },
    tags: { name: 'wager' },
    timeout: REQUEST_TIMEOUT,
  });
  record(response);
}

export function handleSummary(data) {
  return { stdout: `\n${SUMMARY_START}${JSON.stringify(data)}${SUMMARY_END}\n` };
}
