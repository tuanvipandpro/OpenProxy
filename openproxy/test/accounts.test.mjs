import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addOwned, linkCodex, prepareAccount, accountStatus } from '../lib/accounts.mjs';
import { validateName, readJson } from '../lib/store.mjs';
import { portableMessages } from '../lib/server.mjs';
import { engineEnv } from '../lib/engine.mjs';
import { fixture, codexFile } from './helpers.mjs';

test('read-only link projects access token without modifying native credentials or copying refresh', async t => {
  const { store, dir } = await fixture(t);
  const source = codexFile(dir, 'native');
  const original = readFileSync(source, 'utf8');
  await linkCodex(store, 'personal', source);
  const account = store.account('personal');
  const profile = prepareAccount(store, account);
  const projection = readJson(join(profile, 'codex', 'auth.json'));
  assert.equal(projection.refresh, '');
  assert.equal(projection.accountId, 'native');
  assert.equal(readFileSync(source, 'utf8'), original);
  assert.equal(store.load().active, 'personal');
  assert.equal(accountStatus(store, account), 'ready');
  assert.ok(!readFileSync(store.configPath, 'utf8').includes('NEVER-COPY'));
});
test('changed Codex identity is rejected rather than silently routing to another user', async t => {
  const { store, dir } = await fixture(t);
  const source = codexFile(dir, 'native');
  await linkCodex(store, 'personal', source);
  codexFile(dir, 'native', 'different-account');
  assert.throws(() => prepareAccount(store, store.account('personal')), /changed identity/);
  assert.equal(accountStatus(store, store.account('personal')), 'identity-changed');
});
test('expiry inside upstream refresh window fails locally without rotating native refresh token', async t => {
  const { store, dir } = await fixture(t);
  await linkCodex(store, 'personal', codexFile(dir, 'native', 'a', Math.floor(Date.now() / 1000) + 180));
  assert.throws(() => prepareAccount(store, store.account('personal')), /expiring/);
  assert.equal(accountStatus(store, store.account('personal')), 'expired');
});
test('owned accounts and linked accounts coexist; duplicates and path traversal are rejected', async t => {
  const { store, dir } = await fixture(t);
  await addOwned(store, 'secondary');
  await linkCodex(store, 'personal', codexFile(dir, 'native'));
  assert.equal(accountStatus(store, store.account('secondary')), 'needs-login');
  await assert.rejects(addOwned(store, 'personal'), /already exists/);
  for (const name of ['../escape', 'CON', 'nul', 'COM1', 'a/b', '', 'name with spaces']) assert.throws(() => validateName(name));
  const api = join(dir, 'api.json');
  writeFileSync(api, JSON.stringify({ OPENAI_API_KEY: 'fake-api-key' }));
  await assert.rejects(linkCodex(store, 'api', api), /No ChatGPT login/);
});
test('concurrent account updates preserve both profiles', async t => {
  const { store } = await fixture(t);
  await Promise.all([addOwned(store, 'a'), addOwned(store, 'b')]);
  assert.deepEqual(store.load().accounts.map(a => a.name).sort(), ['a', 'b']);
});
test('portable history drops opaque signatures while preserving tool IDs/results and text', () => {
  const body = { messages: [
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'summary', signature: 'opaque-a' }, { type: 'tool_use', id: 'call_1', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file content' }] },
  ] };
  assert.equal(portableMessages(body).messages[0].content[0].signature, undefined);
  assert.equal(body.messages[0].content[1].id, 'call_1');
  assert.equal(body.messages[1].content[0].content, 'file content');
});
test('backend environment isolates diagnostics/provider overrides and disables private continuation', () => {
  process.env.CCP_TRAFFIC_LOG = '1';
  process.env.CLAUDE_CODE_PROXY_CODEX_BASE_URL = 'https://wrong.invalid';
  try {
    const env = engineEnv('test-profile');
    assert.equal(env.CCP_TRAFFIC_LOG, undefined);
    assert.equal(env.CLAUDE_CODE_PROXY_CODEX_BASE_URL, undefined);
    assert.equal(env.CCP_CODEX_PREVIOUS_RESPONSE_ID, '0');
    assert.equal(env.CCP_CODEX_SERVER_COMPACTION, '0');
  } finally { delete process.env.CCP_TRAFFIC_LOG; delete process.env.CLAUDE_CODE_PROXY_CODEX_BASE_URL; }
});
test('CLI links, lists and switches accounts offline without printing tokens', async t => {
  const { store, dir } = await fixture(t);
  const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  const run = args => spawnSync(process.execPath, [cli, '--home', store.root, ...args], { encoding: 'utf8' });
  assert.equal(run(['account', 'link-codex', 'a', '--source', codexFile(dir, 'native-a')]).status, 0);
  assert.equal(run(['account', 'link-codex', 'b', '--source', codexFile(dir, 'native-b')]).status, 0);
  assert.equal(run(['account', 'use', 'b']).status, 0);
  const list = run(['account', 'list']);
  assert.match(list.stdout, /\* b/);
  assert.ok(!list.stdout.includes('NEVER-COPY'));
  assert.equal(run(['account', 'use', 'missing']).status, 1);
});
