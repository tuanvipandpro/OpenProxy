import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readJson, atomicJson, UserError, validateName } from './store.mjs';

export function jwtClaims(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
  catch { return {}; }
}
const EXPIRY_MARGIN = 310_000; // Upstream refreshes five minutes before expiry.
export function readCodex(source) {
  const doc = readJson(source);
  const tokens = doc?.tokens;
  if (typeof tokens?.access_token !== 'string' || !tokens.access_token) {
    throw new UserError('No ChatGPT login in this auth.json. API-key and OS-keyring-only logins are not supported by link-codex.');
  }
  const claims = jwtClaims(tokens.access_token);
  const identity = jwtClaims(tokens.id_token || '');
  const accountId = tokens.account_id || claims['https://api.openai.com/auth']?.chatgpt_account_id || identity['https://api.openai.com/auth']?.chatgpt_account_id || claims.chatgpt_account_id;
  if (!accountId) throw new UserError('Codex credentials have no account ID. Use an independent account login instead.');
  const expires = Number(claims.exp) * 1000;
  if (!Number.isFinite(expires)) throw new UserError('Cannot determine Codex access-token expiration.');
  return { access: tokens.access_token, refresh: '', expires, accountId };
}
export function defaultCodexSource() {
  return join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
}
export async function addOwned(store, name) {
  validateName(name);
  await store.update(config => {
    if (config.accounts.some(a => a.name === name)) throw new UserError(`Account already exists: ${name}`);
    config.accounts.push({ name, mode: 'owned', enabled: true });
    config.active ||= name;
    return config;
  });
  mkdirSync(join(store.profile(name), 'codex'), { recursive: true, mode: 0o700 });
}
export async function linkCodex(store, name, source = defaultCodexSource()) {
  validateName(name);
  const auth = readCodex(resolve(source));
  await store.update(config => {
    if (config.accounts.some(a => a.name === name)) throw new UserError(`Account already exists: ${name}`);
    config.accounts.push({ name, mode: 'codex-readonly', enabled: true, source: resolve(source), accountId: auth.accountId });
    config.active ||= name;
    return config;
  });
}
export function prepareAccount(store, account) {
  assertEnabled(account);
  const dir = store.profile(account.name);
  const authPath = join(dir, 'codex', 'auth.json');
  mkdirSync(join(dir, 'codex'), { recursive: true, mode: 0o700 });
  if (account.mode === 'codex-readonly') {
    const auth = readCodex(account.source);
    if (auth.accountId !== account.accountId) throw new UserError(`Codex source changed identity for ${account.name}. Select another profile or link it under a new name.`, 409);
    if (auth.expires <= Date.now() + EXPIRY_MARGIN) throw new UserError(`Codex session for ${account.name} is expiring. Refresh its login with Codex, or use an independent OpenProxy login.`, 401);
    // Project access only. Never copy or rotate the native client's refresh token.
    atomicJson(authPath, auth);
  } else {
    const auth = readJson(authPath);
    if (!auth?.access) throw new UserError(`Account ${account.name} needs login: openproxy account login ${account.name}`, 401);
  }
  return dir;
}
export function accountEnabled(account) { return account.enabled !== false; }
export function assertEnabled(account) {
  if (!accountEnabled(account)) throw new UserError(`Account ${account.name} is disabled. Enable it before use.`, 409);
}
export async function setAccountEnabled(store, name, enabled) {
  if (typeof enabled !== 'boolean') throw new UserError('Enabled must be true or false.');
  return store.update(config => {
    const account = store.account(name, config);
    account.enabled = enabled;
    if (!enabled && config.active === name) config.active = null;
    return config;
  });
}
export async function selectAccount(store, name) {
  prepareAccount(store, store.account(name));
  return store.update(config => {
    assertEnabled(store.account(name, config));
    config.active = name;
    return config;
  });
}
export function accountCredentials(store, account) {
  let auth;
  if (account.mode === 'codex-readonly') {
    auth = readCodex(account.source);
    if (auth.accountId !== account.accountId) throw new UserError('Account identity changed.', 409);
  } else {
    auth = readJson(join(store.profile(account.name), 'codex', 'auth.json'));
  }
  if (!auth?.access) throw new UserError('Sign-in is required.', 401);
  const claims = jwtClaims(auth.access);
  const accountId = auth.accountId || auth.account_id || claims['https://api.openai.com/auth']?.chatgpt_account_id || claims.chatgpt_account_id;
  return { access: auth.access, accountId, expires: Number(auth.expires) || Number(claims.exp) * 1000,
    planHint: claims['https://api.openai.com/auth']?.chatgpt_plan_type || null };
}
export function accountStatus(store, account) {
  try {
    const auth = account.mode === 'codex-readonly' ? readCodex(account.source) : readJson(join(store.profile(account.name), 'codex', 'auth.json'));
    if (!auth?.access) return 'needs-login';
    if (account.mode === 'codex-readonly' && auth.accountId !== account.accountId) return 'identity-changed';
    if (auth.expires <= Date.now() + EXPIRY_MARGIN) return account.mode === 'owned' && auth.refresh ? 'refresh-on-request' : 'expired';
    return 'ready';
  } catch { return 'unavailable'; }
}
