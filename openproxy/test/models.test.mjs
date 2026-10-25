import test from 'node:test';
import assert from 'node:assert/strict';
import { discoveryModels, normalizeModelRequest, DISCOVERY_PREFIX } from '../lib/models.mjs';
import { listen } from './helpers.mjs';

test('discovery exposes GPT names in compatible routing IDs and excludes unrelated providers', async t => {
  const backend = await listen(t, (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [
      { id: 'gpt-6-sol', display_name: 'gpt-6-sol (codex)' },
      { id: 'gpt-6-luna', display_name: 'gpt-6-luna (codex)' },
      { id: 'gpt-6-sol', display_name: 'gpt-6-sol (codex)' },
      { id: 'gpt-5.6-luna', display_name: 'gpt-5.6-luna (opencode)' },
      { id: 'claude-sonnet-5', display_name: 'claude-sonnet-5 (codex)' },
      { id: 'kimi-k3', display_name: 'kimi-k3 (kimi)' },
    ] }));
  });
  const result = await discoveryModels(backend.url);
  assert.deepEqual(result.data.map(m => m.display_name), ['gpt-6-luna', 'gpt-6-sol']);
  for (const model of result.data) {
    assert.ok(model.id.startsWith('anthropic/'));
    assert.equal(normalizeModelRequest({ model: model.id }).model, model.display_name);
  }
  assert.equal(result.has_more, false);
  const page = await discoveryModels(backend.url, new URLSearchParams('limit=1'));
  assert.equal(page.has_more, true);
  const next = await discoveryModels(backend.url, new URLSearchParams({ limit: '1', after_id: page.last_id }));
  assert.equal(next.data[0].display_name, 'gpt-6-sol');
  assert.equal(next.has_more, false);
  await assert.rejects(discoveryModels(backend.url, new URLSearchParams('limit=0')), /1-1000/);
});
test('model normalization preserves direct user choices and decodes only discovery IDs', () => {
  for (const model of ['gpt-6-sol', 'gpt-6-luna', 'claude-sonnet-5', 'my-custom-model']) {
    assert.equal(normalizeModelRequest({ model }).model, model);
  }
  assert.equal(normalizeModelRequest({ model: DISCOVERY_PREFIX + 'gpt-6-sol[1m]' }).model, 'gpt-6-sol[1m]');
  assert.throws(() => normalizeModelRequest({ model: DISCOVERY_PREFIX + '../escape' }), /Invalid gateway model/);
});
