import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gettingStarted } from '../lib/getting-started.mjs';
import { DesktopController } from '../lib/desktop-controller.mjs';
import { fixture, twoAccounts, listen } from './helpers.mjs';

test('file-only guide works without accounts and never exports credentials during preview', async t => {
  const { store } = await fixture(t);
  const original = readFileSync(store.configPath,'utf8');
  const controller = new DesktopController(store,{ serverFactory: () => assert.fail('guide must not start the proxy') });
  const guide = await controller.dispatch('gettingStarted');
  assert.deepEqual(guide.pages.map(page => page.title),['Claude Code','ChatGPT / Codex','API calls']);
  assert.equal(readFileSync(store.configPath,'utf8'),original);
  assert.ok(!JSON.stringify(guide).includes(store.load().token));
  assert.ok(!/PowerShell|EncodedCommand|Get-Content|apiKeyHelper/.test(JSON.stringify(guide)));
  assert.equal((await controller.status()).running,false);
  assert.match(guide.pages[0].file,/settings\.json$/);
  assert.match(guide.pages[1].file,/config\.toml$/);
  assert.match(guide.pages[1].instructions,/Ordinary ChatGPT desktop\/web chats are not confirmed/);
  await controller.preferences({ port: 2345 });
  for (const page of (await controller.gettingStarted()).pages) {
    assert.ok(page.code.includes('http://127.0.0.1:2345'));
    assert.ok(!page.code.includes('http://127.0.0.1:1234'));
  }
  controller.proxy = { port: 3456, close: async () => {} };
  assert.equal((await controller.gettingStarted()).endpoint,'http://127.0.0.1:3456');
  assert.equal(JSON.parse((await controller.dispatch('clientConfig',{ client: 'claude' })).text).env.ANTHROPIC_BASE_URL,'http://127.0.0.1:3456');
  await controller.close();
});

test('explicit config copy exports only the local key and leaves stored client/account settings unchanged', async t => {
  const { store } = await twoAccounts(t);
  const controller = new DesktopController(store);
  const original = readFileSync(store.configPath,'utf8');
  const copied = await controller.dispatch('clientConfig',{ client: 'claude' });
  const saved = JSON.parse(copied.text);
  assert.equal(saved.env.ANTHROPIC_BASE_URL,'http://127.0.0.1:1234');
  assert.equal(saved.env.ANTHROPIC_AUTH_TOKEN,store.load().token);
  assert.equal(saved.env.ANTHROPIC_MODEL,undefined);
  assert.equal(saved.apiKeyHelper,undefined);
  assert.ok(!copied.text.includes('NEVER-COPY'));
  assert.ok(!/access_token|refresh_token|account_id/.test(copied.text));
  const codex = await controller.dispatch('clientConfig',{ client: 'codex' });
  assert.match(codex.text,/experimental_bearer_token = ".+"/);
  assert.ok(codex.text.includes(store.load().token));
  assert.ok(!/\[model_providers.openproxy.auth\]|command =|env_key/.test(codex.text));
  assert.equal(readFileSync(store.configPath,'utf8'),original);
  await assert.rejects(controller.dispatch('clientConfig',{ client: 'arbitrary' }),/Unknown client configuration/);
  await controller.close();
});

test('raw HTTP sample authenticates a local Responses call without a shell', async t => {
  const { store } = await fixture(t);
  const { server, url } = await listen(t,async (req,res) => {
    assert.equal(req.url,'/v1/responses');
    assert.equal(req.headers.authorization,`Bearer ${store.load().token}`);
    let text = '';
    for await (const chunk of req) text += chunk;
    assert.deepEqual(JSON.parse(text),{ model: 'gpt-test', input: 'Reply with one short greeting.', store: false, stream: false });
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({ id: 'test-response' }));
  });
  const controller = new DesktopController(store);
  controller.proxy = { port: server.address().port, close: async () => {} };
  const raw = (await controller.dispatch('clientConfig',{ client: 'api' })).text.replace('REPLACE_WITH_MODEL_ID','gpt-test');
  const [head,body] = raw.split('\n\n');
  const [request,...headerLines] = head.split('\n');
  const [method,target] = request.split(' ');
  assert.equal(target,url + '/v1/responses');
  const headers = Object.fromEntries(headerLines.map(line => { const split = line.indexOf(':'); return [line.slice(0,split),line.slice(split + 1).trim()]; }));
  const response = await fetch(target,{ method,headers,body });
  assert.equal((await response.json()).id,'test-response');
  await controller.close();
});
