import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { addOwned, linkCodex, prepareAccount, accountStatus, accountEnabled, selectAccount, setAccountEnabled } from './accounts.mjs';
import { SubscriptionService, subscriptionSummary } from './subscription.mjs';
import { gettingStarted, exportClientConfig } from './getting-started.mjs';
import { requireEngine, enginePath, engineEnv } from './engine.mjs';
import { startServer, control } from './server.mjs';
import { UserError, readJson } from './store.mjs';

export class DesktopController {
  constructor(store, { serverFactory = startServer, loginSpawn = spawn, subscriptions = new SubscriptionService(store) } = {}) {
    this.store = store; this.serverFactory = serverFactory; this.loginSpawn = loginSpawn;
    this.proxy = null; this.login = null; this.events = []; this.closed = false;
    this.subscriptions = subscriptions;
  }
  log(message) {
    this.events.push({ time: new Date().toISOString(), message });
    if (this.events.length > 60) this.events.shift();
  }
  async running() {
    if (this.proxy) return { port: this.proxy.port, owned: true };
    if (!readJson(this.store.runtimePath)) return null;
    try {
      await control(this.store, '/_openproxy/status');
      return { port: readJson(this.store.runtimePath).port, owned: false };
    } catch { return null; }
  }
  async status() {
    const config = this.store.load();
    const running = await this.running();
    return {
      running: !!running, owned: !!running?.owned, port: running?.port || config.port,
      endpoint: `http://127.0.0.1:${running?.port || config.port}`, active: config.active,
      accounts: config.accounts.map(account => ({ name: account.name, mode: account.mode, enabled: accountEnabled(account), status: accountStatus(this.store, account), subscription: subscriptionSummary(this.store, account) })),
      login: this.login ? { name: this.login.name } : null,
      engineReady: existsSync(enginePath()), events: this.events,
    };
  }
  async start() {
    if (this.login) throw new UserError('Finish or cancel account login before starting the proxy.');
    if (await this.running()) return this.status();
    const config = this.store.load();
    if (!config.active) throw new UserError('Add or link a ChatGPT account first.');
    prepareAccount(this.store, this.store.account(config.active));
    try {
      this.proxy = await this.serverFactory(this.store, { port: config.port, subscriptions: this.subscriptions, log: message => this.log(message) });
    } catch (error) {
      if (error.code === 'EADDRINUSE') throw new UserError('Port is already in use. Change it in Settings.');
      throw error;
    }
    this.log(`Proxy started on port ${this.proxy.port}.`);
    return this.status();
  }
  async stop() {
    if (this.proxy) {
      await this.proxy.close(); this.proxy = null;
      this.log('Proxy stopped.');
    } else if (await this.running()) throw new UserError('This proxy was started from CLI. Stop it in its terminal.');
    return this.status();
  }
  async select(name) {
    prepareAccount(this.store, this.store.account(name));
    if (await this.running()) await control(this.store, '/_openproxy/account', { method: 'POST', body: { name } });
    else await selectAccount(this.store, name);
    this.log(`Selected ${name}. New requests will use this account.`);
    return this.status();
  }
  async enabled(name, enabled) {
    if (await this.running()) await control(this.store, '/_openproxy/account/enabled', { method: 'POST', body: { name, enabled } });
    else await setAccountEnabled(this.store, name, enabled);
    this.log(`${enabled ? 'Enabled' : 'Disabled'} account ${name}.`);
    return this.status();
  }
  async refreshSubscription(name) {
    let result;
    if (await this.running()) result = await control(this.store, '/_openproxy/account/refresh', { method: 'POST', body: { name } });
    else result = await this.subscriptions.refresh(name);
    this.log(result.error ? `Could not verify subscription for ${name}. Details remain unverified.` : `Refreshed plan and quota for ${name}.`);
    return this.status();
  }
  async link(name, source) {
    await linkCodex(this.store, name, source || undefined);
    this.log(`Linked Codex account: ${name}.`);
    return this.status();
  }
  async add(name) {
    if (this.login || await this.running()) throw new UserError('Stop the proxy before adding or re-authenticating an account.');
    requireEngine();
    await addOwned(this.store, name);
    return this.beginLogin(name);
  }
  async beginLogin(name) {
    if (this.login || await this.running()) throw new UserError('Stop the proxy before adding or re-authenticating an account.');
    const account = this.store.account(name);
    if (account.mode !== 'owned') throw new UserError('This account is linked to Codex. Refresh its login in Codex.');
    const child = this.loginSpawn(requireEngine(), ['codex', 'auth', 'login'], {
      env: engineEnv(this.store.profile(name)), stdio: 'ignore', windowsHide: true,
    });
    const entry = { name, child };
    this.login = entry;
    this.log(`Waiting for ${name} to sign in through the browser…`);
    child.once('error', () => {
      if (this.login !== entry) return;
      this.login = null; this.log(`Could not open sign-in for ${name}. Please try again.`);
    });
    child.once('exit', code => {
      if (this.login !== entry) return;
      this.login = null;
      this.log(code === 0 && accountStatus(this.store, account) === 'ready'
        ? `Signed in to ${name}.` : `Sign-in for ${name} did not complete. You can try again.`);
    });
    return this.status();
  }
  async cancelLogin() {
    if (this.login) {
      const entry = this.login; this.login = null;
      entry.child.kill(); this.log(`Cancelled sign-in for ${entry.name}.`);
    }
    return this.status();
  }
  async preferences(values) {
    if (!values || typeof values !== 'object') throw new UserError('Invalid settings.');
    const running = await this.running();
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new UserError('Choose a port from 1024 to 65535.');
    if (running && port !== running.port) throw new UserError('Stop the proxy before changing its port.');
    await this.store.update(config => {
      config.port = port;
      return config;
    });
    this.log('Settings saved.');
    return this.status();
  }
  async gettingStarted() {
    const running = await this.running();
    return gettingStarted(this.store, { port: running?.port || this.store.load().port });
  }
  async clientConfig(client) {
    const running = await this.running();
    return exportClientConfig(this.store,client,{ port: running?.port || this.store.load().port });
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.cancelLogin();
    if (this.proxy) { await this.proxy.close(); this.proxy = null; }
  }
  async dispatch(method, args = {}) {
    if (this.closed) throw new UserError('Desktop backend is closing.');
    switch (method) {
      case 'status': return this.status();
      case 'start': return this.start();
      case 'stop': return this.stop();
      case 'select': return this.select(args.name);
      case 'enabled': return this.enabled(args.name, args.enabled);
      case 'refreshSubscription': return this.refreshSubscription(args.name);
      case 'gettingStarted': return this.gettingStarted();
      case 'clientConfig': return this.clientConfig(args.client);
      case 'link': return this.link(args.name, args.source);
      case 'add': return this.add(args.name);
      case 'login': return this.beginLogin(args.name);
      case 'cancelLogin': return this.cancelLogin();
      case 'preferences': return this.preferences(args);
      default: throw new UserError('Unknown desktop command.');
    }
  }
}
