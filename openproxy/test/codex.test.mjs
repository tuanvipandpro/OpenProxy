import test from 'node:test';
import assert from 'node:assert/strict';
import { codexProviderConfig, portableResponses } from '../lib/codex.mjs';
import { fixture } from './helpers.mjs';

test('Codex preview is file-only with a key placeholder and no model override', async t => {
  const { store } = await fixture(t);
  const config = codexProviderConfig(store);
  assert.match(config, /model_provider = "openproxy"/);
  assert.match(config, /wire_api = "responses"/);
  assert.match(config, /supports_websockets = false/);
  assert.match(config, /capabilities.remote_compaction = "unsupported"/);
  assert.ok(!config.includes(store.load().token));
  assert.match(config,/experimental_bearer_token = "OPENPROXY_LOCAL_API_KEY"/);
  assert.ok(!/requires_openai_auth|env_key|command =|PowerShell|\[model_providers.openproxy.auth\]/i.test(config));
  assert.ok(!/^model\s*=/m.test(config));
});
test('Responses forwarding preserves portable history while rejecting opaque stored state', () => {
  const body = portableResponses({ model: 'gpt-6-sol', store: true, input: [
    { role: 'user', content: 'hello' },
    { type: 'reasoning', encrypted_content: 'account-a-secret' },
    { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'file content' },
  ] });
  assert.equal(body.store, false); assert.equal(body.input.length, 3);
  assert.equal(body.input[1].call_id, 'call_1');
  assert.throws(() => portableResponses({ previous_response_id: 'account-a-response' }), /full Responses history/);
  assert.throws(() => portableResponses({ input: [{ type: 'compaction', encrypted_content: 'opaque' }] }), /not portable/);
});
