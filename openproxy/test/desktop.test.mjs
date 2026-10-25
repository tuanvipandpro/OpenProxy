import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DesktopController } from '../lib/desktop-controller.mjs';
import { claudeEnvironment } from '../lib/claude.mjs';
import { twoAccounts, fixture } from './helpers.mjs';

async function nextReply(iterator, startup = []) {
  for (;;) {
    const line = await iterator.next();
    if (line.done) throw new Error('Desktop host closed without replying.');
    const message = JSON.parse(line.value);
    if (message.event === 'startup') { startup.push(message); continue; }
    if (message.event === 'fatal') throw new Error(message.error);
    return message;
  }
}

test('desktop opens stopped, starts on demand and stops only its own server on close', async t => {
  const { store } = await twoAccounts(t);
  let starts = 0, stops = 0;
  const controller = new DesktopController(store, {
    serverFactory: async () => { starts++; return { port: 1234, close: async () => { stops++; } }; },
  });
  assert.equal((await controller.status()).running, false);
  assert.equal(starts, 0);
  assert.equal((await controller.start()).running, true);
  await controller.start();
  assert.equal(starts, 1);
  await controller.close(); await controller.close();
  assert.equal(stops, 1);
  assert.equal(store.load().active, 'a');
});
test('desktop switches profiles while stopped and persists settings without exposing credentials', async t => {
  const { store } = await twoAccounts(t);
  const controller = new DesktopController(store);
  await controller.select('b');
  const state = await controller.preferences({ port: 2345 });
  assert.equal(state.active, 'b'); assert.equal(state.port, 2345);
  assert.equal(state.preferences, undefined);
  const wire = JSON.stringify(state);
  assert.ok(!wire.includes('NEVER-COPY'));
  assert.ok(!wire.includes('access_token'));
  assert.ok(!wire.includes(store.load().token));
  await assert.rejects(controller.preferences({ port: 80 }), /1024/);
  await assert.rejects(controller.dispatch('arbitrary-code'), /Unknown desktop command/);
});
test('desktop explains an occupied port without marking the proxy as running', async t => {
  const { store } = await twoAccounts(t);
  const controller = new DesktopController(store, {
    serverFactory: async () => { const error = new Error('occupied'); error.code = 'EADDRINUSE'; throw error; },
  });
  await assert.rejects(controller.start(), /already in use/);
  assert.equal((await controller.status()).running, false);
});
test('desktop login uses an isolated hidden process, can be cancelled and cannot race a running proxy', async t => {
  const { store } = await fixture(t);
  let loginChild;
  const controller = new DesktopController(store, {
    loginSpawn(exe, args, options) {
      assert.deepEqual(args, ['codex', 'auth', 'login']);
      assert.equal(options.windowsHide, true);
      assert.equal(options.stdio, 'ignore');
      loginChild = new EventEmitter(); loginChild.killed = false; loginChild.kill = () => { loginChild.killed = true; };
      return loginChild;
    },
  });
  const status = await controller.add('new-account');
  assert.equal(status.login.name, 'new-account');
  await assert.rejects(controller.start(), /Finish or cancel/);
  await controller.cancelLogin();
  assert.equal(loginChild.killed, true);
  assert.equal((await controller.status()).login, null);
  controller.proxy = { port: 1234, close: async () => {} };
  await assert.rejects(controller.beginLogin('new-account'), /Stop the proxy/);
  await controller.close();
});
test('closing desktop during login terminates the auth process', async t => {
  const { store } = await fixture(t);
  let killed = false;
  const child = new EventEmitter(); child.kill = () => { killed = true; };
  const controller = new DesktopController(store, { loginSpawn: () => child });
  await controller.add('personal');
  await controller.close();
  assert.equal(killed, true);
});
test('Claude launcher isolates credentials and enables discovery without injecting a model', async t => {
  const { store } = await fixture(t);
  process.env.ANTHROPIC_API_KEY = 'DO-NOT-INHERIT';
  process.env.CLAUDE_CODE_USE_BEDROCK = '1';
  try {
    const env = claudeEnvironment(store, 1234);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, store.load().token);
    assert.equal(env.ANTHROPIC_MODEL, process.env.ANTHROPIC_MODEL);
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL);
    assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, process.env.ANTHROPIC_SMALL_FAST_MODEL);
    assert.equal(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, '1');
    assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:1234');
  } finally { delete process.env.ANTHROPIC_API_KEY; delete process.env.CLAUDE_CODE_USE_BEDROCK; }
});
test('user-owned model environment is preserved, while legacy model and project choices are ignored', async t => {
  const { store, dir } = await twoAccounts(t);
  const previous = process.env.ANTHROPIC_MODEL;
  process.env.ANTHROPIC_MODEL = 'user-selected-model';
  try { assert.equal(claudeEnvironment(store, 1234).ANTHROPIC_MODEL, 'user-selected-model'); }
  finally { if (previous === undefined) delete process.env.ANTHROPIC_MODEL; else process.env.ANTHROPIC_MODEL = previous; }
  await store.update(config => { config.desktop = { model: 'old-main', fastModel: 'old-fast', cwd: dir }; return config; });
  const controller = new DesktopController(store);
  await controller.preferences({ port: 2345 });
  assert.deepEqual(store.load().desktop, { model: 'old-main', fastModel: 'old-fast', cwd: dir });
  assert.equal((await controller.status()).preferences, undefined);
  await assert.rejects(controller.dispatch('launch'), /Unknown desktop command/);
  await assert.rejects(controller.dispatch('codexConfig'), /Unknown desktop command/);
  await controller.close();
});
test('stdio host replies with sanitized status and shuts down on command', { timeout: 12000 }, async t => {
  const { store } = await twoAccounts(t);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../desktop-host.mjs', import.meta.url))], {
    env: { ...process.env, OPENPROXY_HOME: store.root }, stdio: ['pipe','pipe','pipe'], windowsHide: true,
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  child.stdin.write(JSON.stringify({ id: 1, method: 'status' }) + '\n');
  const startup = [];
  const status = await nextReply(iterator,startup);
  assert.deepEqual(startup.map(item => item.stage), ['modules','localState','ready']);
  assert.ok(startup.every(item => Number.isInteger(item.elapsedMs)));
  assert.ok(!JSON.stringify(startup).includes(store.load().token));
  assert.equal(status.id, 1); assert.equal(status.result.running, false);
  assert.deepEqual(status.result.accounts.map(a => a.name), ['a','b']);
  child.stdin.write(JSON.stringify({ id: 2, method: 'gettingStarted' }) + '\n');
  const guide = await nextReply(iterator);
  assert.equal(guide.id, 2);
  assert.equal(guide.result.pages.length, 3);
  assert.ok(!JSON.stringify(guide).includes(store.load().token));
  child.stdin.write(JSON.stringify({ id: 3, method: 'clientConfig', args: { client: 'claude' } }) + '\n');
  const exported = await nextReply(iterator);
  assert.equal(exported.id,3);
  assert.equal(JSON.parse(exported.result.text).env.ANTHROPIC_AUTH_TOKEN,store.load().token);
  assert.ok(!exported.result.text.includes('NEVER-COPY'));
  child.stdin.write(JSON.stringify({ id: 4, method: 'shutdown' }) + '\n');
  const closed = await nextReply(iterator);
  assert.equal(closed.result.closed, true);
  await new Promise(resolve => child.once('exit', resolve));
});
test('desktop backend releases a real proxy listener and lock when its parent stdin disappears', { timeout: 12000 }, async t => {
  const { store } = await twoAccounts(t);
  await store.update(config => { config.port = 0; return config; });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../desktop-host.mjs', import.meta.url))], {
    env: { ...process.env, OPENPROXY_HOME: store.root }, stdio: ['pipe','pipe','pipe'], windowsHide: true,
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  child.stdin.write(JSON.stringify({ id: 1, method: 'start' }) + '\n');
  const started = await nextReply(iterator);
  assert.equal(started.result.running, true);
  assert.equal((await fetch(started.result.endpoint + '/healthz')).status, 200);
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.stdin.end();
  await exited;
  assert.equal(existsSync(store.runtimePath), false);
  assert.equal(existsSync(join(store.root, '.server.lock')), false);
  await assert.rejects(fetch(started.result.endpoint + '/healthz'));
});
