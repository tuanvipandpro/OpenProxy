import { statSync, readdirSync } from 'node:fs';
import { join, dirname, extname, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { UserError } from './store.mjs';

function envValue(env, key) {
  return Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] || '';
}
export function expandWindowsEnvironment(value, env = process.env) {
  return value.replace(/%([^%]+)%/g, (match, key) => envValue(env, key) || match);
}
function pathParts(value, env) {
  return value.split(';').map(part => expandWindowsEnvironment(part.trim().replace(/^"|"$/g, ''), env)).filter(Boolean);
}
export function registeredWindowsPaths(env = process.env, run = spawnSync) {
  const reg = join(envValue(env, 'SystemRoot') || 'C:\\Windows', 'System32', 'reg.exe');
  const values = [];
  for (const key of ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']) {
    const result = run(reg, ['query', key, '/v', 'Path'], { encoding: 'utf8', windowsHide: true, timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
    if (result.status !== 0) continue;
    const value = result.stdout?.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.+)$/im)?.[1];
    if (value) values.push(...pathParts(value, env));
  }
  return values;
}
function executableFile(path) {
  try { return /\.(exe|cmd|bat)$/i.test(extname(path)) && statSync(path).isFile(); }
  catch { return false; }
}
function desktopAlias(path) {
  return /[\\/]Microsoft[\\/]WindowsApps[\\/]claude\.exe$/i.test(path);
}
function directories(path) {
  try { return readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name); }
  catch { return []; }
}
function desktopCachedCli(env) {
  const appData = envValue(env, 'APPDATA'), local = envValue(env, 'LOCALAPPDATA');
  const roots = [
    ...(appData ? [join(appData, 'Claude', 'claude-code')] : []),
    ...(local ? [join(local, 'Claude', 'claude-code')] : []),
  ];
  if (local) {
    const packages = join(local, 'Packages');
    for (const family of directories(packages).filter(name => /^Claude_[a-z0-9]+$/i.test(name))) {
      roots.push(join(packages, family, 'LocalCache', 'Roaming', 'Claude', 'claude-code'));
    }
  }
  const versions = [];
  for (const root of roots) {
    for (const version of directories(root).filter(name => /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(name))) {
      versions.push({ path: join(root, version), numbers: version.split('.').slice(0, 3).map(n => parseInt(n, 10)) });
    }
  }
  versions.sort((a, b) => b.numbers[0] - a.numbers[0] || b.numbers[1] - a.numbers[1] || b.numbers[2] - a.numbers[2]);
  for (const version of versions) {
    for (const folder of [version.path, ...directories(version.path).map(name => join(version.path, name))]) {
      const candidate = join(folder, 'claude.exe');
      if (executableFile(candidate)) return candidate;
    }
  }
  return null;
}
export function validateClaudePath(value, env = process.env) {
  if (typeof value !== 'string') throw new UserError('Invalid Claude Code executable path.');
  const path = expandWindowsEnvironment(value.trim().replace(/^"|"$/g, ''), env);
  if (!isAbsolute(path) || !executableFile(path)) throw new UserError('Choose an existing Claude Code .exe, .cmd, or .bat file.');
  if (desktopAlias(path)) throw new UserError('This is a Claude Desktop alias. Choose the Claude Code CLI executable instead.');
  return path;
}
export function resolveClaudeExecutable(configured = '', { env = process.env, registryPaths } = {}) {
  if (configured?.trim()) return validateClaudePath(configured, env);
  const user = envValue(env, 'USERPROFILE');
  const appData = envValue(env, 'APPDATA');
  const local = envValue(env, 'LOCALAPPDATA');
  const prefix = envValue(env, 'npm_config_prefix');
  const directories = [
    ...(user ? [join(user, '.local', 'bin')] : []),
    ...(local ? [join(local, 'Microsoft', 'WinGet', 'Links')] : []),
    ...(appData ? [join(appData, 'npm')] : []),
    ...(prefix ? [prefix] : []),
    ...pathParts(envValue(env, 'PATH'), env),
    ...(registryPaths || registeredWindowsPaths(env)),
  ];
  const seen = new Set();
  for (const directory of directories) {
    if (!isAbsolute(directory)) continue;
    const key = directory.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    for (const name of ['claude.exe', 'claude.cmd', 'claude.bat']) {
      const candidate = join(directory, name);
      if (!desktopAlias(candidate) && executableFile(candidate)) return candidate;
    }
  }
  // Claude Desktop downloads a real CLI separately from its own desktop EXE.
  // This includes the MSIX package's per-user LocalCache directory.
  const cached = desktopCachedCli(env);
  if (cached) return cached;
  throw new UserError('Could not find Claude Code automatically. Use Getting started to configure your terminal, then run the CLI by its full path.');
}
export function refreshLaunchPath(env, executable, registryPaths = registeredWindowsPaths(env)) {
  const entries = [dirname(executable), ...pathParts(envValue(env, 'PATH'), env), ...registryPaths];
  const seen = new Set();
  const path = entries.filter(entry => { const key = entry.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; }).join(';');
  const next = Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== 'path'));
  next.Path = path;
  return next;
}
export function windowsPowerShell(env = process.env) {
  return join(envValue(env, 'SystemRoot') || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
