import { UserError } from './store.mjs';

export const LOCAL_KEY_PLACEHOLDER = 'OPENPROXY_LOCAL_API_KEY';

export function portableResponses(body) {
  if (!body || typeof body !== 'object') return body;
  if (body.previous_response_id) throw new UserError('Send full Responses history; previous_response_id is not portable between accounts.');
  if (Array.isArray(body.input)) {
    if (body.input.some(item => item?.type === 'compaction' || item?.type === 'item_reference')) {
      throw new UserError('Account-specific stored/compaction references are not portable. Use full history and local compaction.');
    }
    body.input = body.input.filter(item => item?.type !== 'reasoning');
  }
  body.store = false;
  return body;
}
export function codexProviderConfig(store, { port = store.load().port, token = LOCAL_KEY_PLACEHOLDER } = {}) {
  return [
    '# Merge with your existing config.toml; do not replace unrelated settings.',
    '# Select your model and project in Codex. The native login is unchanged.',
    'model_provider = "openproxy"', '',
    '[model_providers.openproxy]', 'name = "OpenProxy"',
    `base_url = ${JSON.stringify(`http://127.0.0.1:${port}/v1`)}`,
    'wire_api = "responses"', 'supports_websockets = false',
    'capabilities.remote_compaction = "unsupported"',
    `experimental_bearer_token = ${JSON.stringify(token)}`, '',
  ].join('\n');
}
