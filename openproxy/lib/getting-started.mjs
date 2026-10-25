import { join } from 'node:path';
import { codexProviderConfig, LOCAL_KEY_PLACEHOLDER } from './codex.mjs';
import { UserError } from './store.mjs';

function claudeSettings(port, token = LOCAL_KEY_PLACEHOLDER) {
  return JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_CUSTOM_HEADERS: '',
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000',
  } },null,2) + '\n';
}
function apiExample(port, token = LOCAL_KEY_PLACEHOLDER) {
  return [
    `POST http://127.0.0.1:${port}/v1/responses HTTP/1.1`,
    `Authorization: Bearer ${token}`,
    'Content-Type: application/json', '',
    JSON.stringify({ model: 'REPLACE_WITH_MODEL_ID', input: 'Reply with one short greeting.', store: false, stream: false },null,2), '',
  ].join('\n');
}

// Previews never include a credential value. A deliberate Copy action requests
// a complete local-client configuration from exportClientConfig below.
export function gettingStarted(store, { port = store.load().port } = {}) {
  return {
    endpoint: `http://127.0.0.1:${port}`,
    pages: [
      {
        id: 'claude', title: 'Claude Code', intro: 'Connect by editing one settings file. No terminal setup required.',
        file: process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR,'settings.json') : '%USERPROFILE%\\.claude\\settings.json',
        instructions: [
          '1. Select an enabled account in OpenProxy, then start the proxy.',
          '2. Open the settings.json file shown below in your editor. Create it if it does not exist.',
          '3. Back up existing settings. Click Copy config and merge the env object into the file.',
          '4. Save, restart Claude Code, check /status, then choose a GPT model with /model.',
          '',
          'Copy config includes the local proxy key. Keep this file private. Existing model/project preferences can stay.',
          'Replace old OpenProxy helper settings; remove conflicting CLAUDE_CODE_USE_* flags in client settings/environment.',
          'Use Claude Code 2.1.257+ for model discovery. This configures the CLI; Claude Desktop has separate settings.',
        ].join('\n'),
        code: claudeSettings(port), copyLabel: 'Copy config',
      },
      {
        id: 'codex', title: 'ChatGPT / Codex', intro: 'Route local Codex chats through OpenProxy with a config.toml provider.',
        file: process.env.CODEX_HOME ? join(process.env.CODEX_HOME,'config.toml') : '%USERPROFILE%\\.codex\\config.toml',
        instructions: [
          '1. Select an enabled account in OpenProxy, then start the proxy.',
          '2. Open the user config.toml shown below. Back up the file before editing.',
          '3. Click Copy config. Set model_provider at the top, before any [table], and add the provider section.',
          '4. Save, fully restart Codex, and create a new local chat. Choose your project and model there.',
          '',
          'Replace the old OpenProxy provider/auth sections; do not duplicate keys or tables. Keep unrelated settings.',
          'Copy config includes the local proxy key. Your native login/avatar stays unchanged.',
          'Ordinary ChatGPT desktop/web chats are not confirmed to use this Codex configuration.',
        ].join('\n'),
        code: codexProviderConfig(store,{ port }), copyLabel: 'Copy config',
      },
      {
        id: 'api', title: 'API calls', intro: 'Use a local HTTP client such as Postman. No shell commands required.',
        file: 'Raw HTTP request',
        instructions: [
          '1. Start OpenProxy with an enabled, selected account.',
          '2. Click Copy request and import/paste it into your HTTP client.',
          '3. GET /v1/models with the same Authorization header to list models, then replace REPLACE_WITH_MODEL_ID.',
          '4. Send the POST request. New calls use the account currently selected in OpenProxy.',
          '',
          `Base URL: http://127.0.0.1:${port}/v1. Copy request includes the local proxy key.`,
          'Supports Responses and Anthropic Messages. Browser-origin calls and /v1/chat/completions are unsupported.',
        ].join('\n'),
        code: apiExample(port), copyLabel: 'Copy request',
      },
    ],
  };
}

export function exportClientConfig(store, client, { port = store.load().port } = {}) {
  if (!['claude','codex','api'].includes(client)) throw new UserError('Unknown client configuration.');
  const token = store.load().token;
  return { text: client === 'claude' ? claudeSettings(port,token)
    : client === 'codex' ? codexProviderConfig(store,{ port,token }) : apiExample(port,token) };
}
