import http from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { EngineManager } from './engine.mjs';
import { accountStatus, accountEnabled, assertEnabled, selectAccount, setAccountEnabled } from './accounts.mjs';
import { SubscriptionService, subscriptionSummary } from './subscription.mjs';
import { atomicJson, readJson, UserError } from './store.mjs';
import { discoveryModels, normalizeModelRequest } from './models.mjs';
import { portableResponses } from './codex.mjs';

const routes = new Set(['POST /v1/messages', 'POST /v1/messages/count_tokens', 'GET /v1/models', 'POST /v1/responses']);
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'authorization', 'x-api-key', 'cookie', 'set-cookie']);
function filteredHeaders(headers) {
  const connection = String(headers.connection || '').toLowerCase().split(',').map(v => v.trim());
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !hopHeaders.has(key) && !connection.includes(key)));
}
function authenticated(req, token) {
  const supplied = req.headers.authorization?.replace(/^Bearer /i, '') || req.headers['x-api-key'] || '';
  const a = Buffer.from(supplied), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function bodyJson(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 4096) throw new UserError('Control request too large.', 413);
  }
  try { return JSON.parse(text); } catch { throw new UserError('Invalid JSON.'); }
}
export function portableMessages(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return body;
  // The native encrypted reasoning replay is account-specific. Keep ordinary
  // text/tool history portable, including when switching back to an account.
  for (const message of body.messages) {
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === 'thinking') delete block.signature;
      }
    }
  }
  return body;
}
async function messageBody(req, responses = false) {
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new UserError('Compressed request bodies are not supported.', 415);
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024 * 1024) throw new UserError('Message body exceeds 64 MiB.', 413);
    chunks.push(chunk);
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new UserError('Invalid Messages JSON.'); }
  const normalized = normalizeModelRequest(parsed);
  return Buffer.from(JSON.stringify(responses ? portableResponses(normalized) : portableMessages(normalized)));
}
export async function startServer(store, { port = store.load().port, manager, subscriptions = new SubscriptionService(store), log = console.log } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UserError('Invalid port.');
  const instance = randomUUID();
  const lock = join(store.root, '.server.lock');
  if (existsSync(lock)) {
    const owner = readJson(join(lock, 'owner.json'));
    let alive = true;
    if (Number.isInteger(owner?.pid) && owner.pid > 0) {
      try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    }
    if (alive) throw new UserError('A server already owns this OPENPROXY_HOME, or its lock needs manual recovery.');
    rmSync(lock, { recursive: true, force: true });
  }
  mkdirSync(lock);
  atomicJson(join(lock, 'owner.json'), { pid: process.pid, instance });
  let engines;
  try { engines = manager || new EngineManager(store); }
  catch (error) { rmSync(lock, { recursive: true, force: true }); throw error; }
  const sockets = new Set();
  const config = store.load();
  const server = http.createServer(async (req, res) => {
    try {
      // Reject browser requests and DNS-rebinding hostnames, including /healthz.
      if (req.headers.origin || !/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(req.headers.host || '')) throw new UserError('Only local non-browser clients are accepted.', 403);
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      if (req.method === 'GET' && path === '/healthz') return json(res, 200, { ok: true, service: 'openproxy', instance });
      if (!authenticated(req, config.token)) throw new UserError('Invalid local proxy token. Follow Getting started to configure your client.', 401);
      if (req.method === 'GET' && path === '/_openproxy/status') {
        const current = store.load();
        return json(res, 200, {
          service: 'openproxy', instance, active: current.active,
          accounts: current.accounts.map(a => ({ name: a.name, mode: a.mode, enabled: accountEnabled(a), status: accountStatus(store, a), subscription: subscriptionSummary(store, a) })),
        });
      }
      if (req.method === 'POST' && path === '/_openproxy/account') {
        const { name } = await bodyJson(req);
        await selectAccount(store, name);
        log(`Active account: ${name}. In-flight requests keep their original account.`);
        return json(res, 200, { active: name });
      }
      if (req.method === 'POST' && path === '/_openproxy/account/enabled') {
        const { name, enabled } = await bodyJson(req);
        const current = await setAccountEnabled(store, name, enabled);
        log(`${enabled ? 'Enabled' : 'Disabled'} account: ${name}.`);
        return json(res, 200, { enabled, active: current.active });
      }
      if (req.method === 'POST' && path === '/_openproxy/account/refresh') {
        const { name } = await bodyJson(req);
        return json(res, 200, await subscriptions.refresh(name));
      }
      if (!routes.has(`${req.method} ${path}`)) throw new UserError('Route not found.', 404);
      // Snapshot at request admission; switching later never changes this request.
      const current = store.load();
      if (!current.active) throw new UserError('No account selected. Add an account first.', 503);
      const account = { ...store.account(current.active, current) };
      assertEnabled(account);
      let aborted = false;
      req.once('aborted', () => { aborted = true; });
      res.once('close', () => { if (!res.writableEnded) aborted = true; });
      const body = req.method === 'POST' ? await messageBody(req, path === '/v1/responses') : undefined;
      const backend = await engines.get(account);
      if (aborted || res.destroyed) return;
      if (req.method === 'GET' && path === '/v1/models') {
        const catalog = await discoveryModels(backend.url, new URL(req.url, 'http://127.0.0.1').searchParams);
        return json(res, 200, catalog);
      }
      const headers = filteredHeaders(req.headers);
      if (body) headers['content-length'] = String(body.length);
      const upstream = http.request(backend.url + req.url, { method: req.method, headers });
      upstream.setTimeout(600_000, () => upstream.destroy(new Error('timeout')));
      const cancel = () => { if (!res.writableEnded) upstream.destroy(); };
      res.once('close', cancel);
      req.once('aborted', () => upstream.destroy());
      upstream.once('response', response => {
        const headers = filteredHeaders(response.headers);
        headers['x-openproxy-account'] = account.name;
        headers['cache-control'] = 'no-store';
        res.writeHead(response.statusCode, headers);
        res.flushHeaders();
        response.once('error', () => res.destroy());
        response.once('aborted', () => res.destroy());
        response.pipe(res);
      });
      upstream.once('error', () => {
        if (res.destroyed) return;
        if (res.headersSent) return res.destroy();
        json(res, 502, { type: 'error', error: { type: 'api_error', message: `Engine connection failed for ${account.name}. Request was not replayed.` } });
      });
      upstream.end(body);
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy();
      json(res, error instanceof UserError ? error.status : 500, {
        type: 'error', error: { type: 'api_error', message: error instanceof UserError ? error.message : 'Internal proxy error. No request replayed.' },
      });
    }
  });
  server.requestTimeout = 600_000;
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const cleanup = () => {
    const runtime = readJson(store.runtimePath);
    if (runtime?.instance === instance) rmSync(store.runtimePath, { force: true });
    rmSync(lock, { recursive: true, force: true });
  };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    port = server.address().port;
    atomicJson(store.runtimePath, { port, pid: process.pid, instance });
    await store.update(current => { current.port = port; return current; });
  } catch (error) { server.close(); await engines.close(); cleanup(); throw error; }
  let closing;
  return {
    port, instance, server,
    close() {
      return closing ||= (async () => {
        const stopped = new Promise(resolve => server.close(resolve));
        for (const socket of sockets) socket.destroy();
        await stopped;
        await engines.close();
        cleanup();
      })();
    },
  };
}
export async function control(store, path, { method = 'GET', body } = {}) {
  const runtime = readJson(store.runtimePath);
  if (!runtime) throw new UserError('Proxy is not running. Run: openproxy serve', 503);
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
      method, headers: { authorization: `Bearer ${store.load().token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(path === '/_openproxy/account/refresh' ? 12000 : 5000),
    });
  } catch { throw new UserError('Cannot reach proxy. Restart it with: openproxy serve', 503); }
  const result = await response.json();
  if (!response.ok) throw new UserError(result.error?.message || 'Proxy command failed.', response.status);
  if (path === '/_openproxy/status' && result.instance !== runtime.instance) throw new UserError('Server identity changed. Retry the command.');
  return result;
}
