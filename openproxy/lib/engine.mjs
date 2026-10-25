import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareAccount } from './accounts.mjs';
import { UserError } from './store.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export const ENGINE_VERSION = 'v0.1.46';
export function enginePath() {
  return process.env.OPENPROXY_ENGINE ? resolve(process.env.OPENPROXY_ENGINE)
    : join(projectRoot, '.openproxy', 'engine', ENGINE_VERSION, process.platform === 'win32' ? 'claude-code-proxy.exe' : 'claude-code-proxy');
}
export async function setupEngine() {
  const platforms = { win32: 'windows', darwin: 'darwin', linux: 'linux' };
  const architectures = { x64: 'amd64', arm64: 'arm64' };
  const os = platforms[process.platform], arch = architectures[process.arch];
  if (!os || !arch) throw new UserError('No upstream release for this platform. Set OPENPROXY_ENGINE to a locally built executable.');
  const name = `claude-code-proxy-${os}-${arch}`;
  const base = `https://github.com/raine/claude-code-proxy/releases/download/${ENGINE_VERSION}/${name}`;
  const extension = os === 'windows' ? '.zip' : '.tar.gz';
  const binary = enginePath();
  if (process.env.OPENPROXY_ENGINE) throw new UserError('Unset OPENPROXY_ENGINE to install the pinned release.');
  mkdirSync(dirname(binary), { recursive: true });
  const stage = join(dirname(binary), `download-${randomUUID()}`);
  mkdirSync(stage);
  try {
    const [archiveResponse, checksumResponse] = await Promise.all([
      fetch(base + extension, { signal: AbortSignal.timeout(120_000) }),
      fetch(base + '.sha256', { signal: AbortSignal.timeout(30_000) }),
    ]);
    if (!archiveResponse.ok || !checksumResponse.ok) throw new UserError('Could not download the pinned engine release from GitHub.');
    const archive = Buffer.from(await archiveResponse.arrayBuffer());
    const expected = (await checksumResponse.text()).match(/\b[a-f0-9]{64}\b/i)?.[0]?.toLowerCase();
    const actual = createHash('sha256').update(archive).digest('hex');
    if (!expected || expected !== actual) throw new UserError('Engine archive checksum mismatch; nothing installed.');
    const archivePath = join(stage, 'engine' + extension);
    writeFileSync(archivePath, archive);
    let unpack;
    // Windows ships bsdtar, which also reads ZIP. Avoid PowerShell profile and
    // Expand-Archive dependencies in the installer.
    unpack = spawnSync('tar', ['-xf', archivePath, '-C', stage], { windowsHide: true, stdio: 'pipe' });
    if (unpack.status !== 0) throw new UserError('Cannot unpack engine archive.');
    const unpacked = join(stage, os === 'windows' ? 'claude-code-proxy.exe' : 'claude-code-proxy');
    if (!existsSync(unpacked)) throw new UserError('Engine executable missing from archive.');
    if (os !== 'windows') chmodSync(unpacked, 0o755);
    const version = spawnSync(unpacked, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (version.status !== 0 || !version.stdout?.includes(ENGINE_VERSION.slice(1))) throw new UserError('Downloaded engine did not pass its version check.');
    renameSync(unpacked, binary);
    writeFileSync(join(dirname(binary), 'release.json'), JSON.stringify({ version: ENGINE_VERSION, archiveSha256: actual, source: base + extension }, null, 2));
    return binary;
  } finally {
    // stage is a newly created child of the fixed engine directory.
    rmSync(stage, { recursive: true, force: true });
  }
}
export function requireEngine() {
  const path = enginePath();
  if (!existsSync(path)) throw new UserError('Engine is not installed. Run: openproxy setup');
  return path;
}
export function engineEnv(profile, extra = {}) {
  // Do not inherit provider overrides, auth, or diagnostic flags from another session.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CCP_|CLAUDE_CODE_PROXY_|ANTHROPIC_|OPENAI_|CODEX_)/i.test(key)));
  return {
    ...env, CCP_CONFIG_DIR: profile, CCP_BIND_ADDRESS: '127.0.0.1', CCP_ALIAS_PROVIDER: 'codex',
    CCP_CODEX_TRANSPORT: 'http', CCP_CODEX_PREVIOUS_RESPONSE_ID: '0', CCP_CODEX_SERVER_COMPACTION: '0',
    CCP_CODEX_RESPONSES_API: '1', CCP_CODEX_IMAGES_API: '0', CCP_CODEX_TRANSCRIPTIONS_API: '0',
    XDG_STATE_HOME: join(profile, 'state'), LOCALAPPDATA: join(profile, 'state'),
    ...extra,
  };
}
async function freePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
export class EngineManager {
  constructor(store, { executable = requireEngine(), extraEnv = {} } = {}) {
    this.store = store; this.executable = executable; this.extraEnv = extraEnv;
    this.engines = new Map(); this.children = new Set(); this.closed = false;
  }
  async get(account) {
    if (this.closed) throw new UserError('Proxy is shutting down.', 503);
    const profile = prepareAccount(this.store, account);
    let pending = this.engines.get(account.name);
    if (!pending) {
      pending = this.start(account, profile);
      this.engines.set(account.name, pending);
      pending.catch(() => { if (this.engines.get(account.name) === pending) this.engines.delete(account.name); });
    }
    return pending;
  }
  async start(account, profile) {
    const port = await freePort();
    if (this.closed) throw new UserError('Proxy is shutting down.', 503);
    const child = spawn(process.execPath, [fileURLToPath(new URL('../engine-host.mjs', import.meta.url)), this.executable, 'serve', '--no-monitor', '--port', String(port)], {
      env: engineEnv(profile, this.extraEnv), stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    });
    this.children.add(child);
    let exited = false;
    child.once('error', () => { exited = true; this.children.delete(child); });
    child.once('exit', () => { exited = true; this.children.delete(child); this.engines.delete(account.name); });
    const url = `http://127.0.0.1:${port}`;
    try {
      for (let i = 0; i < 100; i++) {
        if (exited || this.closed) throw new UserError(`Engine for ${account.name} stopped.`, 502);
        try {
          const response = await fetch(url + '/healthz', { signal: AbortSignal.timeout(300) });
          if (response.ok && (await response.json()).ok && !exited) return { url, child, account: account.name };
        } catch { /* starting */ }
        await delay(50);
      }
      throw new UserError(`Engine for ${account.name} did not become ready.`, 502);
    } catch (error) { if (child.connected) child.send('shutdown', () => {}); throw error; }
  }
  async close() {
    this.closed = true;
    await Promise.all([...this.children].map(child => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', resolve); child.once('error', resolve);
      if (child.connected) child.send('shutdown', () => {});
      else child.kill();
    })));
    this.engines.clear();
  }
}
