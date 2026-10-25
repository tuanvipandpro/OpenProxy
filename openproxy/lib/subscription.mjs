import { createHash } from 'node:crypto';
import { accountCredentials, assertEnabled } from './accounts.mjs';
import { UserError } from './store.mjs';

const ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage';
const STALE_MS = 5 * 60_000;
function planName(value) { return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,49}$/i.test(value) ? value.toLowerCase() : 'unknown'; }
function fingerprint(auth) { return createHash('sha256').update(String(auth.accountId)).digest('hex'); }
function windowData(value, name) {
  if (!value || typeof value !== 'object') return null;
  const percent = value.used_percent;
  return { name,
    usedPercent: typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null,
    resetsAt: Number.isSafeInteger(value.reset_at) && value.reset_at > 0 ? value.reset_at : null,
    durationSeconds: Number.isSafeInteger(value.limit_window_seconds) && value.limit_window_seconds > 0 ? value.limit_window_seconds : null,
  };
}
export function parseSubscription(payload, checkedAt) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new UserError('Invalid usage response.');
  const rate = payload.rate_limit;
  const usageStatus = rate?.limit_reached === true || rate?.allowed === false ? 'limited' : rate?.allowed === true ? 'available' : 'unknown';
  const windows = [windowData(rate?.primary_window, 'Primary'), windowData(rate?.secondary_window, 'Secondary')].filter(Boolean);
  return {
    plan: planName(payload.plan_type), planSource: planName(payload.plan_type) === 'unknown' ? 'unknown' : 'server',
    // Usage/plan access does not establish billing renewal or cancellation state.
    subscriptionStatus: 'unknown', usageStatus, windows, checkedAt, lastSuccessAt: checkedAt,
    error: null, stale: false,
  };
}
export function subscriptionSummary(store, account, now = Date.now()) {
  let auth;
  try { auth = accountCredentials(store, account); } catch { /* No inference from failed auth. */ }
  const cached = account.subscription;
  if (cached && auth?.accountId && cached.identity === fingerprint(auth)) {
    return { plan: cached.plan, planSource: cached.planSource, subscriptionStatus: 'unknown',
      usageStatus: cached.usageStatus, windows: cached.windows || [], checkedAt: cached.checkedAt || null,
      lastSuccessAt: cached.lastSuccessAt || null, error: cached.error || null,
      stale: !!cached.stale || !cached.lastSuccessAt || now - Date.parse(cached.lastSuccessAt) > STALE_MS };
  }
  const hint = planName(auth?.planHint);
  return { plan: hint, planSource: hint === 'unknown' ? 'unknown' : 'token', subscriptionStatus: 'unknown',
    usageStatus: 'unknown', windows: [], checkedAt: null, lastSuccessAt: null, error: null, stale: true };
}
export class SubscriptionService {
  constructor(store, { fetchUsage = fetch, now = () => Date.now() } = {}) {
    this.store = store; this.fetchUsage = fetchUsage; this.now = now; this.pending = new Map();
  }
  refresh(name) {
    const account = { ...this.store.account(name) };
    assertEnabled(account);
    if (this.pending.has(name)) return this.pending.get(name);
    const task = this.check(account).finally(() => this.pending.delete(name));
    this.pending.set(name, task);
    return task;
  }
  async check(account) {
    const checkedAt = new Date(this.now()).toISOString();
    let auth, result;
    try {
      auth = accountCredentials(this.store, account);
      if (!auth.accountId) throw new UserError('Account ID is unavailable.');
      if (!Number.isFinite(auth.expires) || auth.expires <= this.now()) throw new UserError('Access token expired.', 401);
      const response = await this.fetchUsage(ENDPOINT, {
        method: 'GET', headers: { authorization: `Bearer ${auth.access}`, 'ChatGPT-Account-Id': auth.accountId,
          accept: 'application/json', 'user-agent': 'OpenProxy/0.6.1' },
        redirect: 'error', signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const error = new UserError('Usage information is unavailable.', response.status);
        throw error;
      }
      // Keep only allowlisted fields; raw responses/errors and credentials are
      // never persisted, sent to the desktop, or written to activity logs.
      result = parseSubscription(await response.json(), checkedAt);
    } catch (error) {
      const old = subscriptionSummary(this.store, account, this.now());
      result = { ...old, checkedAt, stale: true,
        error: error.status === 401 ? 'auth_required' : error.status === 403 ? 'access_denied' : error.status === 429 ? 'refresh_rate_limited' : 'unavailable' };
    }
    if (auth?.accountId) {
      const identity = fingerprint(auth);
      await this.store.update(config => {
        const current = this.store.account(account.name, config);
        let latest;
        try { latest = accountCredentials(this.store, current); } catch { return config; }
        if (latest.accountId && fingerprint(latest) === identity) current.subscription = { ...result, identity };
        return config;
      });
    }
    return result;
  }
}
