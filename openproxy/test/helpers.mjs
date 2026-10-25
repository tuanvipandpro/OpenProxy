import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { Store } from '../lib/store.mjs';
import { linkCodex } from '../lib/accounts.mjs';

const tempRoot = fileURLToPath(new URL('../../.openproxy/tests/', import.meta.url));
export async function fixture(t) {
  mkdirSync(tempRoot, { recursive: true });
  const dir = mkdtempSync(join(tempRoot, 'case-'));
  t.after(() => {
    if (!resolve(dir).startsWith(resolve(tempRoot) + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('Unexpected cleanup path');
    rmSync(dir, { recursive: true, force: true });
  });
  const store = await new Store(join(dir, 'state')).init();
  return { dir, store };
}
export function token(account, expiry = Math.floor(Date.now() / 1000) + 3600) {
  return `test.${Buffer.from(JSON.stringify({ exp: expiry, 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.signature`;
}
export function codexFile(dir, name, account = name, expiry) {
  const source = join(dir, name + '.json');
  writeFileSync(source, JSON.stringify({ tokens: { access_token: token(account, expiry), refresh_token: 'NEVER-COPY-THIS-REFRESH', account_id: account } }));
  return source;
}
export async function twoAccounts(t) {
  const result = await fixture(t);
  for (const name of ['a', 'b']) await linkCodex(result.store, name, codexFile(result.dir, name));
  return result;
}
export async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
export function request(store, url, path = '/v1/messages', body = { model: 'gpt-6-sol', max_tokens: 32, messages: [{ role: 'user', content: 'hello' }] }) {
  return fetch(url + path, {
    method: 'POST', headers: { authorization: `Bearer ${store.load().token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}
export function deferred() { return Promise.withResolvers(); }
