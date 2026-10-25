import { UserError } from './store.mjs';

// Claude Code gateway discovery filters IDs to those containing "claude" or
// "anthropic". These routing IDs are namespaced for discovery; their visible
// names remain the actual GPT IDs. They do not claim Claude model capabilities.
export const DISCOVERY_PREFIX = 'anthropic/openproxy/';
const MODEL_ID = /^gpt-[a-zA-Z0-9._-]+(?:\[1m\])?$/;

export function normalizeModelRequest(body) {
  if (typeof body?.model === 'string' && body.model.startsWith(DISCOVERY_PREFIX)) {
    const model = body.model.slice(DISCOVERY_PREFIX.length);
    if (!MODEL_ID.test(model)) throw new UserError('Invalid gateway model ID.');
    body.model = model;
  }
  return body;
}

export async function discoveryModels(backendUrl, query = new URLSearchParams()) {
  let response, catalog;
  try {
    response = await fetch(backendUrl + '/v1/models', { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('engine catalog unavailable');
    catalog = await response.json();
    if (!Array.isArray(catalog.data)) throw new Error('invalid engine catalog');
  } catch { throw new UserError('Could not load the engine model catalog. Try /model again or restart Claude Code.', 502); }
  const ids = [...new Set(catalog.data
    .filter(entry => typeof entry?.id === 'string' && MODEL_ID.test(entry.id) && /\(codex\)$/.test(entry.display_name || ''))
    .map(entry => entry.id))].sort();
  let data = ids.map(id => ({
    type: 'model', id: DISCOVERY_PREFIX + id, display_name: id,
    description: 'OpenAI model via your selected ChatGPT account. Access depends on the account.',
  }));
  const after = query.get('after_id'), before = query.get('before_id');
  if (after) { const index = data.findIndex(entry => entry.id === after); if (index < 0) throw new UserError('Unknown model pagination cursor.'); data = data.slice(index + 1); }
  if (before) { const index = data.findIndex(entry => entry.id === before); if (index < 0) throw new UserError('Unknown model pagination cursor.'); data = data.slice(0, index); }
  const requestedLimit = query.get('limit');
  const limit = requestedLimit === null ? 1000 : Number(requestedLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new UserError('Model catalog limit must be 1-1000.');
  const hasMore = data.length > limit;
  data = data.slice(0, limit);
  return { data, has_more: hasMore, first_id: data[0]?.id || null, last_id: data.at(-1)?.id || null };
}
