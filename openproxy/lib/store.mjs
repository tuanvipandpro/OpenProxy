import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function defaultHome() {
  return process.env.OPENPROXY_HOME || (process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'OpenProxy')
    : join(homedir(), '.local', 'share', 'openproxy'));
}
export function validateName(name) {
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name || '') || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name)) {
    throw new UserError('Account name: 1-40 lowercase letters, digits, _ or -; no Windows reserved names.');
  }
  return name;
}
export function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new UserError(`Cannot read JSON file: ${path}`);
  }
}
export function atomicJson(path, value) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
}
export class Store {
  constructor(root = defaultHome()) {
    this.root = resolve(root);
    this.configPath = join(this.root, 'openproxy.json');
    this.runtimePath = join(this.root, 'server.json');
  }
  async init() {
    const fresh = !existsSync(this.root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (fresh && process.platform === 'win32') {
      const identity = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
      const sid = identity.stdout?.match(/S-1-5-[\d-]+/)?.[0];
      if (!sid) throw new UserError('Cannot determine Windows user SID to protect credential directory.');
      const acl = spawnSync('icacls.exe', [this.root, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, stdio: 'pipe' });
      if (acl.status !== 0) throw new UserError('Cannot restrict credential directory permissions.');
    }
    // Opening a valid store is read-only. Avoid taking a writer lock and
    // rewriting credentials/settings on every desktop or CLI startup.
    if (existsSync(this.configPath)) this.load();
    else await this.update(config => config);
    return this;
  }
  load() {
    const data = readJson(this.configPath);
    if (!data || data.version !== 1 || !Array.isArray(data.accounts) || typeof data.token !== 'string') {
      throw new UserError('OpenProxy configuration is missing or invalid.');
    }
    return data;
  }
  async update(fn) {
    const lock = join(this.root, '.config.lock');
    let acquired = false;
    for (let i = 0; i < 100; i++) {
      try { mkdirSync(lock); acquired = true; break; }
      catch (error) { if (error.code !== 'EEXIST') throw error; await delay(30); }
    }
    if (!acquired) throw new UserError('Configuration is locked by another command. If it crashed, remove .config.lock in OPENPROXY_HOME.');
    try {
      const data = readJson(this.configPath) || {
        version: 1, port: 1234, active: null, token: randomBytes(32).toString('hex'), accounts: [],
      };
      const next = await fn(data);
      atomicJson(this.configPath, next);
      return next;
    } finally { rmSync(lock, { recursive: true, force: true }); }
  }
  account(name, config = this.load()) {
    validateName(name);
    const item = config.accounts.find(a => a.name === name);
    if (!item) throw new UserError(`Unknown account: ${name}`, 404);
    return item;
  }
  profile(name) { return join(this.root, 'accounts', validateName(name)); }
}
