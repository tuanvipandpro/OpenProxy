import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { UserError } from './store.mjs';
import { resolveClaudeExecutable, refreshLaunchPath, registeredWindowsPaths, windowsPowerShell } from './claude-path.mjs';

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
const TERMINAL_BOOTSTRAP = "$ErrorActionPreference = 'Stop'; Start-Process -FilePath $env:OPENPROXY_POWERSHELL -ArgumentList @('-NoLogo', '-NoProfile', '-NoExit', '-Command', '& $env:OPENPROXY_CLAUDE_EXECUTABLE') -WorkingDirectory $env:OPENPROXY_WORKDIR -WindowStyle Normal";

export async function launchClaudeTerminal(store, port, preferences = {}, { spawnChild = spawn, homeDir = homedir(), ...dependencies } = {}) {
  // Project selection belongs to Claude Code. Ignore legacy OpenProxy cwd
  // preferences and open the terminal at the user's home directory.
  const cwd = homeDir;
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new UserError('The user home directory is unavailable.');
  const env = claudeLaunchEnvironment(store, port, preferences, dependencies);
  const powershell = windowsPowerShell(env);
  env.OPENPROXY_POWERSHELL = powershell;
  env.OPENPROXY_WORKDIR = cwd;
  // Start-Process creates a real interactive console instead of giving Claude
  // the desktop backend's redirected standard handles. All paths travel in
  // environment variables; neither executable nor project paths become code.
  const child = spawnChild(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', TERMINAL_BOOTSTRAP], {
    env, cwd, stdio: 'ignore', windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    child.once('error', () => reject(new UserError('Could not open a terminal for Claude Code. Follow Getting started to configure your own terminal.')));
    child.once('exit', code => code === 0 ? resolve() : reject(new UserError('Could not open a terminal for Claude Code. Check the executable path and terminal availability.')));
  });
  return child;
}
