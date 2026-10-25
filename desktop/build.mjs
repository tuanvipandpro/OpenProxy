import { existsSync, mkdirSync, copyFileSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { requireEngine } from '../openproxy/lib/engine.mjs';
import { appIcon } from './icon.mjs';

if (process.platform !== 'win32') throw new Error('The native desktop build targets Windows. Run on Windows.');
const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version;
if (process.argv.slice(2).some(arg => arg !== '--versioned')) throw new Error('Usage: node desktop/build.mjs [--versioned]');
const outputName = process.argv.includes('--versioned') ? `OpenProxy-${version}` : 'OpenProxy';
const output = join(root,'dist',outputName);
const resources = join(output,'resources');
const build = join(root,'.openproxy','build');
for (const path of [output, build, join(resources,'runtime'), join(resources,'engine'), join(resources,'openproxy'), join(output,'licenses')]) mkdirSync(path,{recursive:true});
const compiler = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
if (!existsSync(compiler)) throw new Error('.NET Framework C# compiler was not found.');
writeFileSync(join(build,'openproxy.ico'),appIcon());
const compile = spawnSync(compiler,[
  '/nologo','/target:winexe','/platform:x64','/optimize+','/codepage:65001',
  '/r:System.dll','/r:System.Core.dll','/r:System.Drawing.dll','/r:System.Windows.Forms.dll','/r:System.Web.Extensions.dll',
  '/win32manifest:' + join(root,'desktop','app.manifest'), '/win32icon:' + join(build,'openproxy.ico'),
  '/resource:' + join(build,'openproxy.ico') + ',OpenProxy.Icon',
  '/out:' + join(output,'OpenProxy.exe'), join(root,'desktop','OpenProxy.cs'),
],{encoding:'utf8',windowsHide:true});
if (compile.status !== 0) throw new Error('Desktop compilation failed:\n' + compile.stdout + compile.stderr);
copyFileSync(join(root,'desktop','OpenProxy.exe.config'),join(output,'OpenProxy.exe.config'));
copyFileSync(process.execPath,join(resources,'runtime','node.exe'));
copyFileSync(requireEngine(),join(resources,'engine','claude-code-proxy.exe'));
copyFileSync(join(root,'LICENSE'),join(output,'licenses','claude-code-proxy-LICENSE.txt'));
copyFileSync(join(root,'SELF_TEST.md'),join(output,'SELF_TEST.md'));
for (const entry of readdirSync(join(root,'openproxy'),{withFileTypes:true})) {
  if (entry.isFile() && entry.name.endsWith('.mjs')) copyFileSync(join(root,'openproxy',entry.name),join(resources,'openproxy',entry.name));
}
mkdirSync(join(resources,'openproxy','lib'),{recursive:true});
for (const name of readdirSync(join(root,'openproxy','lib'))) if (name.endsWith('.mjs')) copyFileSync(join(root,'openproxy','lib',name),join(resources,'openproxy','lib',name));
// Keep Node's bundled third-party notices with the redistributed runtime.
const licensePath = join(output,'licenses','Node-LICENSE.txt');
if (!existsSync(licensePath)) {
  const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`,{signal:AbortSignal.timeout(30_000)});
  if (!response.ok) throw new Error('Cannot fetch the license for the bundled Node version.');
  writeFileSync(licensePath,await response.text());
}
writeFileSync(join(output,'README.txt'),`OpenProxy Desktop ${version} — Windows x64

Keep resources next to OpenProxy.exe. No separate Node installation is needed.
Requires Windows 10/11 x64 with .NET Framework 4.8.

Add accounts and select one before starting the proxy. Enable/Disable controls
eligibility; disabling the active account pauses new inference traffic until you
select another enabled account. There is no automatic account rotation.
Refresh reads plan/quota information without running a model. Missing data and
billing renewal status remain Unknown. Stale/unverified data is labeled.

Startup shows five loading stages and elapsed time before the main window.
The desktop uses neutral dark surfaces, compact cards, and readable actions.
Getting started has a dark sidebar for Claude Code, ChatGPT / Codex, and API
calls. The combined guide explains config.toml, base_url, and authentication.
Claude Code uses settings.json; Codex uses config.toml. Follow the four steps,
copy config, merge into your existing file, save, and restart your client.
No shell setup or credential helper is needed. API examples use raw HTTP.
The app never launches coding clients or edits their configuration. Settings
contains only the local port. Choose projects and models inside your client.
Previews show a key placeholder. Explicit Copy config/request actions include
the local proxy key. Keep copied configurations private; no upstream tokens
are exported. Nothing edits client files automatically.
Ordinary ChatGPT chat routing is unverified; local Codex uses the Codex guide.

Read SELF_TEST.md for manual UI/live-account checks, expected results, and Codex
configuration limitations. This release has not been tested through native UI.
Closing the app stops its proxy; it does not start automatically with Windows.
Data is outside the portable folder at %LOCALAPPDATA%\\OpenProxy.

Source: https://github.com/raine/claude-code-proxy (engine MIT)
`.replace(/\n/g,'\r\n'));
writeFileSync(join(output,'build-info.json'),JSON.stringify({version,node:process.version,engine:'v0.1.46',builtAt:new Date().toISOString()},null,2));
const archive = join(root,'dist',outputName+'-windows-x64.zip');
const packed = spawnSync('tar.exe',['-a','-cf',archive,'-C',dirname(output),outputName],{windowsHide:true,encoding:'utf8'});
if (packed.status !== 0) throw new Error('Cannot create portable ZIP: '+packed.stderr);
const checksum = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(archive+'.sha256',checksum+'  '+basename(archive)+'\n');
console.log('Desktop executable: '+join(output,'OpenProxy.exe'));
console.log('Portable archive: '+archive);
