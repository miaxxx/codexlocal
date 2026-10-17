import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSettings } from '../src/config/settings.mjs';
import { redSquareDataUrl } from './fixtures/red-square.mjs';

const settings = await loadSettings();
const base = `http://${settings.host}:${settings.port}`;
const headers = { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' };
const report = { date: new Date().toISOString(), tests: [] };
async function test(name, fn) {
  const started = Date.now();
  const detail = await fn();
  report.tests.push({ name, passed: true, ms: Date.now() - started, ...detail });
  console.log(`通过：${name}`);
}
async function post(body) {
  const response = await fetch(base + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: 'codex-local', ...body }), signal: AbortSignal.timeout(settings.timeoutMs + 10000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response;
}
await test('模型目录', async () => {
  const r = await fetch(base + '/v1/models', { headers });
  const list = await r.json();
  assert.ok(list.data.some(m => m.id === 'codex-local'));
  return { models: list.data.map(m => m.id) };
});
await test('真实非流式文本', async () => {
  const r = await (await post({ messages: [{ role: 'user', content: 'Reply with exactly LOCAL_API_OK.' }] })).json();
  assert.equal(r.choices[0].message.content.trim(), 'LOCAL_API_OK');
  assert.equal(r.choices[0].finish_reason, 'stop');
  return { answer: r.choices[0].message.content, usage: r.usage };
});
await test('真实 SSE 流式文本', async () => {
  const response = await post({ stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'Reply with exactly STREAM_OK.' }] });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const text = await response.text();
  const events = text.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6));
  assert.equal(events.at(-1), '[DONE]');
  const chunks = events.slice(0, -1).map(e => JSON.parse(e));
  assert.ok(!chunks.some(c => c.error), JSON.stringify(chunks));
  const answer = chunks.map(c => c.choices[0]?.delta.content ?? '').join('');
  assert.equal(answer.trim(), 'STREAM_OK');
  assert.ok(chunks.some(c => c.choices[0]?.finish_reason === 'stop'));
  return { answer, chunks: chunks.length };
});
const tools = [{ type: 'function', function: { name: 'lookup_supplier', description: 'Look up the supplier risk. Do not invent the risk.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } } }];
const messages = [{ role: 'user', content: '请调用 lookup_supplier 查询 supplier-1 的风险，拿到工具结果后再告诉我风险。' }];
let call, assistant;
await test('真实函数工具调用', async () => {
  const response = await (await post({ messages, tools, tool_choice: 'required' })).json();
  assert.equal(response.choices[0].finish_reason, 'tool_calls');
  assistant = response.choices[0].message;
  call = assistant.tool_calls[0];
  assert.equal(call.function.name, 'lookup_supplier');
  assert.equal(JSON.parse(call.function.arguments).id, 'supplier-1');
  return { tool: call.function.name, arguments: call.function.arguments };
});
await test('真实工具结果续接', async () => {
  const result = await (await post({ messages: [...messages, assistant, { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ id: 'supplier-1', risk: 'low', testMarker: 'RESULT_731' }) }], tools })).json();
  assert.equal(result.choices[0].finish_reason, 'stop');
  assert.match(result.choices[0].message.content, /low|低/);
  return { answer: result.choices[0].message.content };
});
await test('真实 SSE 工具调用', async () => {
  const response = await post({ stream: true, messages, tools, tool_choice: { type: 'function', function: { name: 'lookup_supplier' } } });
  const data = (await response.text()).split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6));
  assert.equal(data.at(-1), '[DONE]');
  const events = data.slice(0, -1).map(e => JSON.parse(e));
  assert.ok(!events.some(e => e.error));
  const streamedCall = events.flatMap(e => e.choices[0]?.delta.tool_calls ?? [])[0];
  assert.equal(streamedCall.function.name, 'lookup_supplier');
  assert.equal(JSON.parse(streamedCall.function.arguments).id, 'supplier-1');
  assert.ok(events.some(e => e.choices[0]?.finish_reason === 'tool_calls'));
  return { tool: streamedCall.function.name };
});
await test('真实图片输入', async () => {
  const response = await (await post({ messages: [{ role: 'user', content: [
    { type: 'text', text: 'What is the dominant color in the attached square? Reply with exactly one English uppercase color word.' },
    { type: 'image_url', image_url: { url: redSquareDataUrl() } },
  ] }] })).json();
  assert.equal(response.choices[0].message.content.trim(), 'RED');
  return { answer: response.choices[0].message.content };
});
await test('真实 JSON Schema 回复', async () => {
  const response = await (await post({ messages: [{ role: 'user', content: 'Return answer SCHEMA_OK.' }],
    response_format: { type: 'json_schema', json_schema: { name: 'probe', strict: true, schema: {
      type: 'object', properties: { answer: { type: 'string', enum: ['SCHEMA_OK'] } }, required: ['answer'], additionalProperties: false,
    } } },
  })).json();
  assert.deepEqual(JSON.parse(response.choices[0].message.content), { answer: 'SCHEMA_OK' });
  return { answer: response.choices[0].message.content };
});
await writeFile(join(settings.root, 'smoke-results.json'), JSON.stringify(report, null, 2) + '\n');
console.log('完整结果已写入 smoke-results.json');
