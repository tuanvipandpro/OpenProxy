import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, control } from '../lib/server.mjs';
import { twoAccounts, listen, request, deferred } from './helpers.mjs';

async function setup(t, handler) {
  const fixture = await twoAccounts(t);
  const admissions = [];
  const backend = await listen(t, handler || ((req, res) => { res.end(req.headers['x-test-account']); }));
  const manager = {
    async get(account) {
      admissions.push(account.name);
      // Dedicated per-account engines in production. Here encode the same
      // separation with two mock backend URLs.
      return { url: backend.url + '/' + account.name };
    },
    async close() {},
  };
  const proxy = await startServer(fixture.store, { port: 0, manager, log() {} });
  t.after(() => proxy.close());
  return { ...fixture, admissions, proxy, url: `http://127.0.0.1:${proxy.port}` };
}
test('manual live switch preserves in-flight stream; next request uses new account', async t => {
  const arrived = deferred(), finish = deferred();
  const state = await setup(t, async (req, res) => {
    const account = req.url.split('/')[1];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${account}-start\n\n`);
    if (account === 'a') { arrived.resolve(); await finish.promise; }
    res.end(`data: ${account}-end\n\n`);
  });
  t.after(() => finish.resolve());
  const first = await request(state.store, state.url);
  await arrived.promise;
  assert.equal(first.headers.get('x-openproxy-account'), 'a');
  assert.deepEqual(await control(state.store, '/_openproxy/account', { method: 'POST', body: { name: 'b' } }), { active: 'b' });
  const second = await request(state.store, state.url);
  assert.equal(second.headers.get('x-openproxy-account'), 'b');
  assert.match(await second.text(), /b-end/);
  finish.resolve();
  assert.equal(await first.text(), 'data: a-start\n\ndata: a-end\n\n');
  assert.deepEqual(state.admissions, ['a', 'b']);
  assert.equal((await control(state.store, '/_openproxy/status')).active, 'b');
});
test('disabling an active account stops new traffic without interrupting its in-flight stream', async t => {
  const finish = deferred();
  const state = await setup(t, async (req, res) => {
    const account = req.url.split('/')[1];
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${account}-start\n\n`);
    if (account === 'a') await finish.promise;
    res.end(`data: ${account}-end\n\n`);
  });
  t.after(() => finish.resolve());
  const first = await request(state.store, state.url);
  const disabled = await control(state.store, '/_openproxy/account/enabled', { method: 'POST', body: { name: 'a', enabled: false } });
  assert.equal(disabled.active, null);
  assert.equal((await request(state.store, state.url)).status, 503);
  await assert.rejects(control(state.store, '/_openproxy/account', { method: 'POST', body: { name: 'a' } }), /disabled/);
  await control(state.store, '/_openproxy/account', { method: 'POST', body: { name: 'b' } });
  const second = await request(state.store, state.url);
  assert.match(await second.text(), /b-end/);
  finish.resolve(); assert.match(await first.text(), /a-end/);
  assert.deepEqual(state.admissions, ['a','b']);
  const status = await control(state.store, '/_openproxy/status');
  assert.equal(status.accounts.find(a => a.name === 'a').enabled, false);
  assert.equal(status.active, 'b');
});
test('quota errors stay on selected account and are returned without automatic fallback', async t => {
  let calls = 0;
  const state = await setup(t, (req, res) => {
    calls++; res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
    res.end(JSON.stringify({ error: { message: 'quota exhausted' } }));
  });
  const result = await request(state.store, state.url);
  assert.equal(result.status, 429); assert.equal(result.headers.get('retry-after'), '60');
  assert.match(await result.text(), /quota exhausted/);
  assert.equal(calls, 1); assert.deepEqual(state.admissions, ['a']); assert.equal(state.store.load().active, 'a');
});
test('proxy rejects unauthorized controls, browser origins and rebinding hosts', async t => {
  const state = await setup(t);
  assert.equal((await fetch(state.url + '/_openproxy/status')).status, 401);
  assert.equal((await fetch(state.url + '/_openproxy/account', { method: 'POST', body: '{"name":"b"}' })).status, 401);
  assert.equal((await fetch(state.url + '/healthz', { headers: { origin: 'https://example.com' } })).status, 403);
  const status = await new Promise(resolve => {
    const req = http.get(state.url + '/healthz', { headers: { host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', assert.fail);
  });
  assert.equal(status, 403);
  assert.equal(state.store.load().active, 'a'); assert.equal(state.admissions.length, 0);
});
test('local bearer and cookies are not forwarded; history signatures removed', async t => {
  let received;
  const state = await setup(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received = { headers: req.headers, body: JSON.parse(body) };
    res.end('ok');
  });
  const response = await fetch(state.url + '/v1/messages?beta=true', {
    method: 'POST', headers: { authorization: `Bearer ${state.store.load().token}`, cookie: 'private-cookie', 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'summary', signature: 'opaque' }] }] }),
  });
  assert.equal(await response.text(), 'ok');
  assert.equal(received.headers.authorization, undefined); assert.equal(received.headers.cookie, undefined);
  assert.equal(received.body.messages[0].content[0].signature, undefined);
});
test('unknown account switch is rejected without changing active selection', async t => {
  const state = await setup(t);
  await assert.rejects(control(state.store, '/_openproxy/account', { method: 'POST', body: { name: 'missing' } }), /Unknown account/);
  assert.equal(state.store.load().active, 'a');
});
test('midstream backend failure is not replayed or rotated', async t => {
  let calls = 0;
  const state = await setup(t, (req, res) => {
    calls++; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: partial\n\n');
    setTimeout(() => res.destroy(), 30);
  });
  const response = await request(state.store, state.url);
  await assert.rejects(response.text());
  assert.equal(calls, 1); assert.deepEqual(state.admissions, ['a']);
});
test('client cancellation disconnects backend without replaying', async t => {
  const disconnected = deferred();
  const state = await setup(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: first\n\n');
    res.once('close', () => disconnected.resolve());
  });
  const controller = new AbortController();
  const response = await fetch(state.url + '/v1/messages', {
    method: 'POST', headers: { authorization: `Bearer ${state.store.load().token}` }, body: '{}', signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(response.text());
  await disconnected.promise;
  assert.deepEqual(state.admissions, ['a']);
});
