import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enginePath, EngineManager } from '../lib/engine.mjs';
import { startServer, control } from '../lib/server.mjs';
import { twoAccounts, listen, request } from './helpers.mjs';

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
}
test('engine host terminates its native child when the proxy lifetime channel disappears', { timeout: 8000 }, async () => {
  const host = spawn(process.execPath, [fileURLToPath(new URL('../engine-host.mjs', import.meta.url)), process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
  });
  const pid = await new Promise((resolve, reject) => {
    host.once('message', message => resolve(message.enginePid)); host.once('error', reject);
  });
  assert.ok(Number.isInteger(pid));
  const exited = new Promise(resolve => host.once('exit', resolve));
  host.disconnect();
  await exited;
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
test('real pinned engine translates tool calls/results across a manual account switch', { skip: !existsSync(enginePath()), timeout: 20_000 }, async t => {
  const { store } = await twoAccounts(t);
  const received = [];
  const upstream = await listen(t, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    received.push({ body, account: req.headers['chatgpt-account-id'], auth: req.headers.authorization });
    if (body.input.some(item => item.type === 'function_call_output')) {
      sse(res, [
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_done' } },
        { type: 'response.output_text.delta', output_index: 0, delta: 'Read complete on account B' },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_done' } },
        { type: 'response.completed', response: { id: 'resp_b', status: 'completed', usage: { input_tokens: 10, output_tokens: 5 } } },
      ]);
    } else {
      const item = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read', arguments: '{"path":"notes.txt"}' };
      sse(res, [
        { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'resp_a', status: 'completed', usage: { input_tokens: 8, output_tokens: 3 } } },
      ]);
    }
  });
  const manager = new EngineManager(store, { extraEnv: { CCP_CODEX_BASE_URL: upstream.url + '/responses', NO_PROXY: '127.0.0.1,localhost' } });
  const proxy = await startServer(store, { port: 0, manager, log() {} });
  t.after(() => proxy.close());
  const url = `http://127.0.0.1:${proxy.port}`;
  const discoveryResponse = await fetch(url + '/v1/models?limit=1000', { headers: { authorization: `Bearer ${store.load().token}` } });
  assert.equal(discoveryResponse.status, 200);
  const discovered = await discoveryResponse.json();
  const selected = discovered.data.find(entry => entry.display_name === 'gpt-6-sol');
  assert.ok(selected, 'Claude Code can discover the actual GPT model by name');
  assert.ok(discovered.data.every(entry => entry.id.startsWith('anthropic/openproxy/gpt-')));
  assert.equal(received.length, 0, 'discovery does not send inference requests');
  const tools = [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
  const firstBody = { model: selected.id, max_tokens: 128, stream: false, tools, messages: [{ role: 'user', content: 'Read notes.txt' }] };
  const first = await request(store, url, '/v1/messages', firstBody);
  const response = await first.json();
  assert.equal(first.status, 200, JSON.stringify(response));
  assert.equal(response.stop_reason, 'tool_use');
  const call = response.content.find(block => block.type === 'tool_use');
  assert.equal(call.name, 'Read'); assert.deepEqual(call.input, { path: 'notes.txt' });
  await control(store, '/_openproxy/account', { method: 'POST', body: { name: 'b' } });
  const nextSelection = discovered.data.find(entry => entry.display_name === 'gpt-6-luna');
  assert.ok(nextSelection);
  const second = await request(store, url, '/v1/messages', { ...firstBody, model: nextSelection.id, stream: true, messages: [
    ...firstBody.messages,
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'summary', signature: 'account-a-private' }, ...response.content] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'contents of notes' }] },
  ] });
  assert.equal(second.status, 200);
  const stream = await second.text();
  assert.match(stream, /message_start/); assert.match(stream, /Read complete on account B/); assert.match(stream, /message_stop/);
  assert.deepEqual(received.map(item => item.account), ['a', 'b']);
  assert.deepEqual(received.map(item => item.body.model), ['gpt-6-sol', 'gpt-6-luna'], 'the engine follows each model selected in the picker');
  assert.notEqual(received[0].auth, received[1].auth);
  assert.ok(received[1].body.input.some(item => item.type === 'function_call_output' && item.call_id === call.id));
  assert.ok(!received[1].body.input.some(item => item.type === 'reasoning'));
  assert.equal(received[1].body.previous_response_id, undefined);
  const before = received.length;
  const count = await request(store, url, '/v1/messages/count_tokens', firstBody);
  assert.equal(count.status, 200); assert.ok((await count.json()).input_tokens > 0);
  assert.equal(received.length, before, 'token counting stays local');
});
test('real Responses endpoint routes Codex HTTP requests through the manually selected account', { skip: !existsSync(enginePath()), timeout: 20000 }, async t => {
  const { store } = await twoAccounts(t);
  const received = [];
  const upstream = await listen(t, async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    received.push({ account: req.headers['chatgpt-account-id'], body });
    sse(res,[
      { type: 'response.output_text.delta', output_index: 0, delta: 'ok' },
      { type: 'response.completed', response: { id: 'resp_'+received.length, status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1 } } },
    ]);
  });
  const manager = new EngineManager(store,{ extraEnv: { CCP_CODEX_BASE_URL: upstream.url+'/responses', NO_PROXY: '127.0.0.1,localhost' } });
  const proxy = await startServer(store,{ port: 0, manager, log(){} });
  t.after(()=>proxy.close());
  const url = `http://127.0.0.1:${proxy.port}`;
  const body = { model: 'gpt-6-sol', instructions: 'Answer briefly.', stream: true, input: [{ role: 'user', content: 'hello' }] };
  const first = await request(store,url,'/v1/responses',body);
  assert.equal(first.status,200); assert.match(await first.text(),/response.completed/);
  await control(store,'/_openproxy/account/enabled',{ method:'POST',body:{name:'a',enabled:false} });
  assert.equal((await request(store,url,'/v1/responses',body)).status,503);
  await control(store,'/_openproxy/account',{method:'POST',body:{name:'b'}});
  const second = await request(store,url,'/v1/responses',{...body,input:[...body.input,{type:'reasoning',encrypted_content:'private-a'}]});
  assert.equal(second.status,200); await second.text();
  assert.deepEqual(received.map(r=>r.account),['a','b']);
  assert.ok(received.every(r=>r.body.store===false));
  assert.ok(!received[1].body.input.some(item=>item.type==='reasoning'));
});
