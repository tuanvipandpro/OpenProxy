#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store, UserError, readJson } from './lib/store.mjs';
import { addOwned, linkCodex, accountStatus, prepareAccount, accountEnabled, setAccountEnabled, selectAccount } from './lib/accounts.mjs';
import { SubscriptionService, subscriptionSummary } from './lib/subscription.mjs';
import { codexProviderConfig } from './lib/codex.mjs';
import { setupEngine, requireEngine, engineEnv } from './lib/engine.mjs';
import { startServer, control } from './lib/server.mjs';
import { claudeEnvironment, claudeLaunchEnvironment, CLAUDE_INVOKE } from './lib/claude.mjs';
import { windowsPowerShell } from './lib/claude-path.mjs';

const HELP = `OpenProxy — manual ChatGPT account switching for Claude Code

  openproxy setup                         Download pinned, checksum-verified engine
  openproxy account add NAME              Add an independent login and open browser
  openproxy account add NAME --device     Add an independent login using a device code
  openproxy account login NAME [--device] Re-authenticate an independent account
  openproxy account link-codex NAME       Link the current Codex auth.json read-only
      [--source PATH]                    Link a different Codex profile's auth.json
  openproxy account list                 Show account names and local auth status
  openproxy account use NAME             Select account; running requests stay put
  openproxy account enable NAME          Allow an account to be selected
  openproxy account disable NAME         Block new requests; clear selection if active
  openproxy account refresh NAME         Refresh plan/quota without running a model
  openproxy account info NAME            Show cached plan/quota and verification time
  openproxy serve [--port 1234]           Run the fixed local endpoint
  openproxy status                       Show running proxy/account status
  openproxy models                       Show engine's model catalog (not entitlement)
  openproxy codex-config                 Print a Codex provider config (no token value)
  openproxy claude                        Start Claude Code; choose a model with /model

All commands accept --home PATH (or OPENPROXY_HOME). Default state is outside
the repo in LOCALAPPDATA/OpenProxy on Windows. There is no automatic rotation.
Examples without installing a global command: node openproxy/cli.mjs account list
`;
function takeOption(args, key) {
  const index = args.indexOf(key);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new UserError(`Missing value for ${key}.`);
  args.splice(index, 2);
  return value;
}
function takeFlag(args, key) {
  const index = args.indexOf(key);
  if (index < 0) return false;
  args.splice(index, 1); return true;
}
function noExtra(args) { if (args.length) throw new UserError(`Unexpected arguments: ${args.join(' ')}`); }
async function runChild(command, args, env) {
  const child = spawn(command, args, { env, stdio: 'inherit', windowsHide: false });
  await new Promise((resolve, reject) => {
    child.once('error', () => reject(new UserError(`Cannot start ${command}. Make sure it is installed and on PATH.`)));
    child.once('exit', code => code === 0 ? resolve() : reject(new UserError(`Command exited with status ${code}.`)));
  });
}
async function login(store, name, device) {
  const account = store.account(name);
  if (account.mode !== 'owned') throw new UserError('This is a read-only Codex link. Sign in with Codex, or add an independent account.');
  // Keep one refresh owner: do not run a separate auth process while this server
  // could be refreshing the same profile. Switching accounts itself stays live.
  if (readJson(store.runtimePath)) {
    try { await control(store, '/_openproxy/status'); }
    catch (error) { if (error.status !== 503) throw error; }
    const runtime = readJson(store.runtimePath);
    let running = false;
    try { process.kill(runtime.pid, 0); running = true; } catch { /* stale */ }
    if (running) throw new UserError('Stop openproxy serve before adding or refreshing a login. Account switching does not require a stop.');
  }
  await runChild(requireEngine(), ['codex', 'auth', device ? 'device' : 'login'], engineEnv(store.profile(name)));
  prepareAccount(store, account);
}
export async function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  const root = takeOption(args, '--home');
  if (!args.length || args.includes('--help') || args[0] === 'help') { console.log(HELP); return; }
  if (args[0] === 'setup') { args.shift(); noExtra(args); console.log(`Engine installed: ${await setupEngine()}`); return; }
  const store = await new Store(root).init();
  const command = args.shift();
  if (command === 'codex-config') { noExtra(args); console.log(codexProviderConfig(store)); return; }
  if (command === 'account') {
    const action = args.shift();
    if (action === 'list') {
      noExtra(args);
      const config = store.load();
      if (!config.accounts.length) console.log('No accounts. Run: openproxy account link-codex personal');
      for (const account of config.accounts) console.log(`${config.active === account.name ? '*' : ' '} ${account.name}\t${accountEnabled(account) ? 'enabled' : 'disabled'}\t${account.mode}\t${accountStatus(store, account)}\t${subscriptionSummary(store, account).plan}`);
      return;
    }
    const name = args.shift();
    if (action === 'enable' || action === 'disable') {
      noExtra(args);
      const enabled = action === 'enable';
      if (readJson(store.runtimePath)) await control(store, '/_openproxy/account/enabled', { method: 'POST', body: { name, enabled } });
      else await setAccountEnabled(store, name, enabled);
      console.log(`${enabled ? 'Enabled' : 'Disabled'} account: ${name}.`);
      return;
    }
    if (action === 'refresh' || action === 'info') {
      noExtra(args);
      let summary;
      if (action === 'info') summary = subscriptionSummary(store, store.account(name));
      else if (readJson(store.runtimePath)) summary = await control(store, '/_openproxy/account/refresh', { method: 'POST', body: { name } });
      else summary = await new SubscriptionService(store).refresh(name);
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    if (action === 'add' || action === 'login') {
      const device = takeFlag(args, '--device'); noExtra(args);
      requireEngine();
      if (action === 'add') await addOwned(store, name);
      await login(store, name, device);
      console.log(`Account ready: ${name}`);
      return;
    }
    if (action === 'link-codex') {
      const source = takeOption(args, '--source'); noExtra(args);
      await linkCodex(store, name, source);
      console.log(`Linked read-only: ${name}. Native Codex credentials will not be modified.`);
      return;
    }
    if (action === 'use') {
      noExtra(args);
      prepareAccount(store, store.account(name));
      if (readJson(store.runtimePath)) {
        // Fail if a recorded server is unreachable; do not pretend the live
        // server has acknowledged a switch.
        await control(store, '/_openproxy/account', { method: 'POST', body: { name } });
      } else {
        await selectAccount(store, name);
      }
      console.log(`Active account: ${name}. New requests use this account.`);
      return;
    }
    throw new UserError('Unknown account command. Run: openproxy --help');
  }
  if (command === 'serve') {
    const option = takeOption(args, '--port'); noExtra(args);
    const port = option === undefined ? store.load().port : Number(option);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UserError('Port must be 1-65535.');
    const proxy = await startServer(store, { port });
    console.log(`OpenProxy: http://127.0.0.1:${proxy.port}`);
    console.log(`Active account: ${store.load().active || '(none)'}. Manual switching only. Ctrl+C to stop.`);
    const shutdown = async () => { await proxy.close(); };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
    await new Promise(resolve => proxy.server.once('close', resolve));
    await proxy.close();
    process.removeListener('SIGINT', shutdown); process.removeListener('SIGTERM', shutdown);
    return;
  }
  if (command === 'status') {
    noExtra(args);
    const status = await control(store, '/_openproxy/status');
    console.log(`Active account: ${status.active || '(none)'}`);
    for (const account of status.accounts) console.log(`${account.name}\t${account.mode}\t${account.status}`);
    return;
  }
  if (command === 'models') {
    noExtra(args);
    await runChild(requireEngine(), ['models'], engineEnv(join(store.root, 'catalog')));
    return;
  }
  if (command === 'claude') {
    noExtra(args);
    const status = await control(store, '/_openproxy/status');
    const runtime = readJson(store.runtimePath);
    if (!status.active) throw new UserError('Select an account first.');
    if (process.platform === 'win32') {
      const env = claudeLaunchEnvironment(store, runtime.port, store.load().desktop || {});
      await runChild(windowsPowerShell(env), ['-NoLogo', '-NoProfile', '-Command', CLAUDE_INVOKE + '; exit $LASTEXITCODE'], env);
    } else await runChild('claude', [], claudeEnvironment(store, runtime.port));
    return;
  }
  throw new UserError('Unknown command. Run: openproxy --help');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(error instanceof UserError ? error.message : 'OpenProxy failed. Check engine installation and local state permissions.');
    process.exitCode = 1;
  });
}
