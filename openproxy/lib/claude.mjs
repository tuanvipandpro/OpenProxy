import { resolveClaudeExecutable, refreshLaunchPath, registeredWindowsPaths } from './claude-path.mjs';

export function claudeEnvironment(store, port) {
  // Keep model preferences owned by Claude Code/the user. Replace only
  // credentials and provider routing needed for this local proxy session.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^ANTHROPIC_(API_KEY|BASE_URL|AUTH_TOKEN|CUSTOM_HEADERS|BEDROCK_BASE_URL|VERTEX_BASE_URL|FOUNDRY_BASE_URL|AWS_BASE_URL)$/i.test(key)
    && !/^CLAUDE_CODE_USE_/i.test(key)));
  const env = { ...inherited,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: store.load().token,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    CLAUDE_CODE_GATEWAY_MODEL_DISCOVERY_TIMEOUT_MS: '10000',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000',
  };
  return env;
}
export function claudeLaunchEnvironment(store, port, preferences = {}, dependencies = {}) {
  const registryPaths = dependencies.registryPaths || registeredWindowsPaths(dependencies.env || process.env);
  const executable = resolveClaudeExecutable(preferences.claudePath || '', { ...dependencies, registryPaths });
  const env = refreshLaunchPath(claudeEnvironment(store, port), executable, registryPaths);
  env.OPENPROXY_CLAUDE_EXECUTABLE = executable;
  return env;
}
export const CLAUDE_INVOKE = '& $env:OPENPROXY_CLAUDE_EXECUTABLE';
