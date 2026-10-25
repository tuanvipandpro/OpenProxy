import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { SubscriptionService, subscriptionSummary, parseSubscription } from '../lib/subscription.mjs';
import { setAccountEnabled, selectAccount } from '../lib/accounts.mjs';
import { Store } from '../lib/store.mjs';
import { twoAccounts, codexFile, deferred } from './helpers.mjs';

const payload = { plan_type: 'pro', rate_limit: { allowed: true, limit_reached: false,
  primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1900000000 },
  secondary_window: { used_percent: 60, limit_window_seconds: 604800, reset_at: 1900400000 } } };

test('plan/quota refresh uses only the selected account and persists no credentials or billing guesses', async t => {
  const { store } = await twoAccounts(t);
  const native = store.account('b').source, original = readFileSync(native, 'utf8');
  let sent;
  const service = new SubscriptionService(store, { fetchUsage: async (url, options) => {
    sent = { url, options }; return new Response(JSON.stringify(payload));
  } });
  const result = await service.refresh('b');
  assert.equal(sent.url, 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(sent.options.method, 'GET');
  assert.equal(sent.options.headers['ChatGPT-Account-Id'], 'b');
  assert.equal(sent.options.redirect, 'error');
  assert.equal(result.plan, 'pro'); assert.equal(result.planSource, 'server');
  assert.equal(result.usageStatus, 'available'); assert.equal(result.subscriptionStatus, 'unknown');
  assert.equal(result.windows[0].usedPercent, 25); assert.equal(result.windows[1].resetsAt, 1900400000);
  assert.equal(readFileSync(native, 'utf8'), original);
  const wire = JSON.stringify(subscriptionSummary(store, store.account('b')));
  assert.ok(!wire.includes(sent.options.headers.authorization));
  assert.ok(!readFileSync(store.configPath, 'utf8').includes('NEVER-COPY'));
  assert.equal(store.load().active, 'a', 'refresh never switches the active account');
});
test('failed refresh preserves last-known data with stale/error labels instead of claiming current availability', async t => {
  const { store } = await twoAccounts(t);
  let clock = Date.now(), fails = false;
  const service = new SubscriptionService(store, { now: () => clock, fetchUsage: async () => {
    if (fails) return new Response('SECRET-ERROR-DETAILS', { status: 401 });
    return new Response(JSON.stringify(payload));
  } });
  const first = await service.refresh('a');
  clock += 360_000; fails = true;
  const result = await service.refresh('a');
  assert.equal(result.stale, true); assert.equal(result.error, 'auth_required');
  assert.equal(result.lastSuccessAt, first.lastSuccessAt); assert.notEqual(result.checkedAt, first.checkedAt);
  assert.equal(result.subscriptionStatus, 'unknown');
  assert.ok(!JSON.stringify(store.load()).includes('SECRET-ERROR-DETAILS'));
});
test('disabled accounts cannot be selected or refreshed; enabling alone does not activate them', async t => {
  const { store } = await twoAccounts(t);
  let calls = 0;
  const service = new SubscriptionService(store, { fetchUsage: async () => { calls++; return new Response('{}'); } });
  await setAccountEnabled(store, 'a', false);
  assert.equal(store.load().active, null);
  assert.throws(() => service.refresh('a'), /disabled/);
  await assert.rejects(selectAccount(store, 'a'), /disabled/);
  assert.equal(calls, 0);
  await setAccountEnabled(store, 'a', true);
  assert.equal(store.load().active, null);
  await selectAccount(store, 'b');
  await setAccountEnabled(store, 'a', false);
  assert.equal(store.load().active, 'b');
  await assert.rejects(setAccountEnabled(store, 'a', 'false'), /true or false/);
});
test('legacy profiles default to enabled and disabling persists after reopening the store', async t => {
  const { store } = await twoAccounts(t);
  await store.update(config => { for (const account of config.accounts) delete account.enabled; return config; });
  await selectAccount(store, 'b');
  assert.equal(store.load().active, 'b');
  await setAccountEnabled(store, 'b', false);
  const reopened = await new Store(store.root).init();
  assert.equal(reopened.account('b').enabled, false);
  assert.equal(reopened.load().active, null);
  await assert.rejects(selectAccount(reopened, 'b'), /disabled/);
});
test('concurrent refresh is single-flight and a completed check never re-enables a disabled account', async t => {
  const { store } = await twoAccounts(t);
  const entered = deferred(), complete = deferred(); let calls = 0;
  const service = new SubscriptionService(store, { fetchUsage: async () => { calls++; entered.resolve(); await complete.promise; return new Response(JSON.stringify(payload)); } });
  const first = service.refresh('a'), second = service.refresh('a');
  await entered.promise;
  await setAccountEnabled(store, 'a', false);
  complete.resolve(); await Promise.all([first, second]);
  assert.equal(calls, 1); assert.equal(store.account('a').enabled, false); assert.equal(store.load().active, null);
});
test('missing data stays unknown and expired credentials do not trigger a network request', async t => {
  const { store } = await twoAccounts(t);
  const empty = parseSubscription({}, new Date().toISOString());
  assert.equal(empty.plan, 'unknown'); assert.equal(empty.usageStatus, 'unknown'); assert.equal(empty.subscriptionStatus, 'unknown');
  const limits = parseSubscription({ plan_type: 'plus', rate_limit: { allowed: false, limit_reached: true } }, new Date().toISOString());
  assert.equal(limits.usageStatus, 'limited');
  let calls = 0;
  codexFile(store.root + '/..', 'a', 'a', 1);
  const service = new SubscriptionService(store, { fetchUsage: async () => { calls++; return new Response('{}'); } });
  const result = await service.refresh('a');
  assert.equal(result.error, 'auth_required'); assert.equal(calls, 0);
});
test('token plan hints remain unverified and cached metadata is hidden when identity changes', async t => {
  const { store } = await twoAccounts(t);
  const source = store.account('a').source, doc = JSON.parse(readFileSync(source, 'utf8'));
  const claims = { exp: Math.floor(Date.now()/1000)+3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'a', chatgpt_plan_type: 'plus' } };
  doc.tokens.access_token = 'test.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.test';
  writeFileSync(source, JSON.stringify(doc));
  const hint = subscriptionSummary(store, store.account('a'));
  assert.equal(hint.plan, 'plus'); assert.equal(hint.planSource, 'token'); assert.equal(hint.stale, true);
  const service = new SubscriptionService(store, { fetchUsage: async () => new Response(JSON.stringify(payload)) });
  await service.refresh('a');
  doc.tokens.account_id = 'other'; writeFileSync(source, JSON.stringify(doc));
  const result = subscriptionSummary(store, store.account('a'));
  assert.equal(result.plan, 'unknown'); assert.equal(result.usageStatus, 'unknown');
});
