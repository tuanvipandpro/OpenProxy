import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_VERSION } from '../openproxy/lib/engine.mjs';

const root = fileURLToPath(new URL('../',import.meta.url));
const version = JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version;
assert.match(version,/^\d+\.\d+\.\d+$/,'Release version must be a plain semantic version.');
const source = readFileSync(join(root,'desktop','OpenProxy.cs'),'utf8');
assert.ok(source.includes(`AssemblyVersion("${version}.0")`),'Assembly version does not match package.json.');
assert.ok(source.includes(`AssemblyFileVersion("${version}.0")`),'File version does not match package.json.');
assert.ok(readFileSync(join(root,'desktop','app.manifest'),'utf8').includes(`version="${version}.0"`),'Manifest version mismatch.');
if (process.env.GITHUB_REF_TYPE === 'tag') assert.equal(process.env.GITHUB_REF_NAME,`v${version}`,'Git tag does not match package.json.');
if (process.argv.includes('--metadata-only')) { console.log(`Release metadata verified: ${version}`); process.exit(0); }
assert.equal(process.platform,'win32','Verify the Windows package on Windows.');

const folder = `OpenProxy-${version}`;
const output = join(root,'dist',folder);
const archive = join(root,'dist',`${folder}-windows-x64.zip`);
const info = JSON.parse(readFileSync(join(output,'build-info.json'),'utf8'));
assert.equal(info.version,version);
assert.equal(info.engine,ENGINE_VERSION);
const checksum = createHash('sha256').update(readFileSync(archive)).digest('hex');
assert.equal(readFileSync(archive + '.sha256','utf8').trim(),`${checksum}  ${folder}-windows-x64.zip`);

const listed = spawnSync('tar.exe',['-tf',archive],{ encoding: 'utf8', windowsHide: true });
assert.equal(listed.status,0,'Cannot list portable ZIP.');
const entries = listed.stdout.replace(/\\/g,'/').trim().split(/\r?\n/);
const required = ['OpenProxy.exe','OpenProxy.exe.config','README.txt','SELF_TEST.md','NOTICE.md','RELEASE_NOTES.md','build-info.json',
  'resources/runtime/node.exe','resources/engine/claude-code-proxy.exe','resources/openproxy/desktop-host.mjs',
  'resources/openproxy/engine-host.mjs','resources/openproxy/lib/getting-started.mjs','licenses/Node-LICENSE.txt','licenses/claude-code-proxy-LICENSE.txt'];
for (const path of required) {
  assert.ok(existsSync(join(output,path)),`Required package file missing: ${path}`);
  assert.ok(entries.includes(`${folder}/${path}`),`Required ZIP entry missing: ${path}`);
}
for (const entry of entries) {
  assert.ok(entry.startsWith(folder + '/') && !entry.split('/').includes('..'),'Unexpected ZIP path.');
  assert.ok(!/(?:^|\/)(?:auth\.json|openproxy\.json|server\.json|\.git|node_modules|test|tests)(?:\/|$)/i.test(entry),'Local state or test files must not be packaged.');
}
for (const [relative,expected] of [['resources/runtime/node.exe',info.node],['resources/engine/claude-code-proxy.exe',ENGINE_VERSION.slice(1)]]) {
  const result = spawnSync(join(output,relative),['--version'],{ encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status,0,`Bundled executable failed: ${relative}`);
  assert.ok(result.stdout.includes(expected),`Bundled executable version mismatch: ${relative}`);
}
console.log(`Portable package verified: ${folder}-windows-x64.zip (${entries.length} entries, SHA-256 matched).`);
