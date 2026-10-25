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
const VIRTUAL_USERS = 200;
const RAMP_SHARE = 0.2;
const RESEND_SHARE = 0.1;
const WIN_SHARE = 0.4;
const BET_AMOUNTS = ['1.00', '2.50', '5.00', '0.50'];
const WIN_AMOUNTS = ['2.00', '5.00', '10.00', '1.50'];
const LOSS_AMOUNT = '0.00';
const TOKEN_REFRESH_MARGIN_MS = 30000;
const REQUEST_TIMEOUT = '30s';
const TRACKED_STATUSES = [0, 200, 202, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504];
const DURATION_PATTERN = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;

const durationSeconds = (text) => {
  const match = DURATION_PATTERN.exec(text);
  const seconds = match
    ? Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)
    : 0;
  if (seconds < 2) {
    throw new Error(`DURATION must look like 60s, 2m or 1m30s and last at least 2s: ${text}`);
  }
  return seconds;
};

const totalSeconds = durationSeconds(DURATION);
const rampSeconds = Math.max(1, Math.round(totalSeconds * RAMP_SHARE));

const wallets = new SharedArray('wallets', () => JSON.parse(globalThis.open(WALLETS_FILE)));

const requestDuration = new Trend('wager_request_duration', true);
const statusCounters = new Map(
  TRACKED_STATUSES.map((status) => [status, new Counter(`wager_status_${String(status)}`)]),
);
const otherStatusCounter = new Counter('wager_status_other');
const resends = new Counter('wager_resends');
const replays = new Counter('wager_replays');
const kindCounters = {
  BET: new Counter('wager_kind_bet'),
  WIN: new Counter('wager_kind_win'),
  LOSS: new Counter('wager_kind_loss'),
};

export const options = {
  scenarios: {
    distributed: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: `${String(rampSeconds)}s`, target: VIRTUAL_USERS },
        { duration: `${String(totalSeconds - rampSeconds)}s`, target: VIRTUAL_USERS },
      ],
      gracefulRampDown: '10s',
    },
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

const pick = (values) => values[Math.floor(Math.random() * values.length)];

const record = (response) => {
  requestDuration.add(response.timings.duration);
  const counter = statusCounters.get(response.status);
  if (counter === undefined) {
    otherStatusCounter.add(1);
  } else {
    counter.add(1);
  }
};

const isReplay = (response) => {
  try {
    return response.json('idempotentReplay') === true;
  } catch {
    return false;
  }
};

const send = (body) => {
  const params = {
    headers: {
      Authorization: bearer(),
      'Content-Type': 'application/json',
      'Idempotency-Key': `idem-${body.externalTransactionId}`,
      'X-Correlation-Id': RUN_ID,
    },
    tags: { name: 'wager' },
    timeout: REQUEST_TIMEOUT,
  };
  const payload = JSON.stringify(body);
  const response = http.post(`${API_URL}/wagering/transactions`, payload, params);
  record(response);
  kindCounters[body.kind].add(1);
  if (Math.random() < RESEND_SHARE) {
    const resent = http.post(`${API_URL}/wagering/transactions`, payload, params);
    record(resent);
    resends.add(1);
    if (isReplay(resent)) {
      replays.add(1);
    }
  }
  return response;
};

const isProcessed = (response) => {
  try {
    return response.status === 200 && response.json('status') === 'PROCESSED';
  } catch {
    return false;
  }
};

export default function distributedRound() {
  const wallet = pick(wallets);
  const roundId = `load-${RUN_ID}-d-${String(exec.vu.idInTest)}-${String(exec.vu.iterationInScenario)}`;
  const base = {
    providerId: PROVIDER_ID,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId,
    gameId: 'load-distributed',
  };
  const betId = `${roundId}-bet`;
  const bet = send({
    ...base,
    externalTransactionId: betId,
    kind: 'BET',
    money: { amount: pick(BET_AMOUNTS), currency: wallet.currency },
  });
  if (!isProcessed(bet)) {
    return;
  }
  const settlement =
    Math.random() < WIN_SHARE
      ? { kind: 'WIN', externalTransactionId: `${roundId}-win`, amount: pick(WIN_AMOUNTS) }
      : { kind: 'LOSS', externalTransactionId: `${roundId}-loss`, amount: LOSS_AMOUNT };
  send({
    ...base,
    externalTransactionId: settlement.externalTransactionId,
    kind: settlement.kind,
    money: { amount: settlement.amount, currency: wallet.currency },
    referenceExternalTransactionId: betId,
  });
}

export function handleSummary(data) {
  return { stdout: `\n${SUMMARY_START}${JSON.stringify(data)}${SUMMARY_END}\n` };
}
