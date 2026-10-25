import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { Store } from '../lib/store.mjs';
import { fixture } from './helpers.mjs';

test('reopening valid state does not take the writer lock or rewrite configuration', async t => {
  const { store } = await fixture(t);
  const original = readFileSync(store.configPath,'utf8');
  const before = statSync(store.configPath,{ bigint: true }).mtimeNs;
  mkdirSync(join(store.root,'.config.lock'));
  const reopened = await new Store(store.root).init();
  assert.equal(reopened.load().token,store.load().token);
  assert.equal(readFileSync(store.configPath,'utf8'),original);
  assert.equal(statSync(store.configPath,{ bigint: true }).mtimeNs,before);
});

test('startup reports a fatal local-state error and exits without reporting ready', { timeout: 10000 }, async t => {
  const { store } = await fixture(t);
  writeFileSync(store.configPath,'{invalid-json');
  const child = spawn(process.execPath,[fileURLToPath(new URL('../desktop-host.mjs',import.meta.url))], {
    env: { ...process.env, OPENPROXY_HOME: store.root }, stdio: ['pipe','pipe','ignore'], windowsHide: true,
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exited = new Promise(resolve => child.once('exit',resolve));
  const events = [];
  for await (const line of createInterface({ input: child.stdout })) events.push(JSON.parse(line));
  assert.equal(await exited,1);
  assert.deepEqual(events.filter(event => event.event === 'startup').map(event => event.stage),['modules','localState']);
  assert.equal(events.at(-1).event,'fatal');
  assert.match(events.at(-1).error,/Cannot read JSON/);
});
