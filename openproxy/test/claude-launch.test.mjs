import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, twoAccounts } from './helpers.mjs';
import { resolveClaudeExecutable, registeredWindowsPaths, validateClaudePath, windowsPowerShell } from '../lib/claude-path.mjs';
import { CLAUDE_INVOKE } from '../lib/claude.mjs';
import { DesktopController } from '../lib/desktop-controller.mjs';

function file(path, content = 'test fixture; not a real executable') {
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); return path;
}
test('finds a native Claude Code install even when its folder is absent from PATH', async t => {
  const { dir } = await fixture(t);
  const native = file(join(dir, '.local', 'bin', 'claude.exe'));
  assert.equal(resolveClaudeExecutable('', { env: { USERPROFILE: dir, Path: '' }, registryPaths: [] }), native);
});
test('finds npm shims outside PATH and supports explicit paths containing spaces', async t => {
  const { dir } = await fixture(t);
  const shim = file(join(dir, 'App Data', 'npm', 'claude.cmd'));
  assert.equal(resolveClaudeExecutable('', { env: { APPDATA: join(dir, 'App Data') }, registryPaths: [] }), shim);
  assert.equal(validateClaudePath('"' + shim + '"'), shim);
  await assert.rejects(Promise.resolve().then(() => validateClaudePath(join(dir, 'missing.exe'))), /Choose an existing/);
});
test('reads fresh user/machine registry paths instead of relying on the desktop startup PATH', async t => {
  const { dir } = await fixture(t);
  const target = file(join(dir, 'Fresh install', 'claude.cmd'));
  const env = { CLAUDE_BIN: dirname(target), Path: join(dir, 'old-path') };
  const registryPaths = registeredWindowsPaths(env, (command, args) => ({
    status: 0, stdout: args[1] === 'HKCU\\Environment' ? '    Path    REG_EXPAND_SZ    %CLAUDE_BIN%\r\n' : '    Path    REG_SZ    C:\\Windows\\System32\r\n',
  }));
  assert.ok(registryPaths.includes(dirname(target)));
  assert.equal(resolveClaudeExecutable('', { env, registryPaths }), target);
});
test('skips the Claude Desktop WindowsApps alias and chooses the CLI instead', async t => {
  const { dir } = await fixture(t);
  const alias = file(join(dir, 'Microsoft', 'WindowsApps', 'Claude.exe'));
  const cli = file(join(dir, 'real-cli', 'claude.exe'));
  assert.equal(resolveClaudeExecutable('', { env: { Path: dirname(alias) + ';' + dirname(cli) }, registryPaths: [] }), cli);
  assert.throws(() => validateClaudePath(alias), /Claude Desktop alias/);
});
test('finds the real CLI downloaded by MSIX Claude Desktop and follows the newest cached version', async t => {
  const { dir } = await fixture(t);
  const cache = join(dir, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude-code');
  file(join(cache, '2.1.9', 'old-build', 'claude.exe'));
  const newest = file(join(cache, '2.1.308', 'c17a819afb40', 'claude.exe'));
  assert.equal(resolveClaudeExecutable('', { env: { LOCALAPPDATA: dir }, registryPaths: [] }), newest);
});
test('finds a real CLI cached by the non-MSIX desktop app', async t => {
  const { dir } = await fixture(t);
  const executable = file(join(dir, 'Claude', 'claude-code', '2.1.308', 'build', 'claude.exe'));
  assert.equal(resolveClaudeExecutable('', { env: { APPDATA: dir }, registryPaths: [] }), executable);
});
test('a missing CLI points to the guide and manual invocation', () => {
  assert.throws(() => resolveClaudeExecutable('', { env: {}, registryPaths: [] }), /Getting started.*full path/);
});
test('PowerShell safely invokes an npm shim from a path with spaces and shell metacharacters', { skip: process.platform !== 'win32', timeout: 12000 }, async t => {
  const { dir } = await fixture(t);
  const executable = file(join(dir, 'CLI & tools (test)', 'claude.cmd'), '@echo off\r\n> "%OPENPROXY_PROBE_OUTPUT%" echo launched\r\n');
  const output = join(dir, 'probe.txt');
  const result = spawnSync(windowsPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', CLAUDE_INVOKE + '; exit $LASTEXITCODE'], {
    env: { ...process.env, OPENPROXY_CLAUDE_EXECUTABLE: executable, OPENPROXY_PROBE_OUTPUT: output },
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, 'utf8').trim(), 'launched');
});
test('desktop only saves its port and rejects port changes while running', async t => {
  const { store } = await twoAccounts(t);
  const controller = new DesktopController(store);
  controller.proxy = { port: 1234, close: async () => {} };
  const result = await controller.preferences({ port: 1234 });
  assert.equal(result.running, true);
  assert.equal(result.preferences, undefined);
  await assert.rejects(controller.preferences({ port: 2345 }), /changing its port/);
  await controller.close();
});
