import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexBackend } from '../src/codex/backend.mjs';
import { validateRequest } from '../src/openai/request.mjs';
import { ApiError } from '../src/http/errors.mjs';

function makeClient(turnEvents) {
  const instances = [];
  class FakeClient extends EventEmitter {
    constructor() { super(); this.closed = false; this.requests = []; instances.push(this); }
    async initialize() {}
    async request(method, params) {
      this.requests.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'thread_test' } };
      if (method === 'turn/start') { queueMicrotask(() => turnEvents(this)); return { turn: { id: 'turn_test' } }; }
      return {};
    }
    close() { this.closed = true; }
    fail(error) { this.emit('failure', error); this.close(); }
  }
  return { FakeClient, instances };
}
function backend(Client, timeoutMs = 1000) {
  const b = new CodexBackend({ alias: 'codex-local', cwd: '/test/workspace', timeoutMs }, Client);
  b.models = [{ model: 'test-model', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }];
  b.defaultModel = 'test-model';
  return b;
}
const body = () => validateRequest({ model: 'codex-local', messages: [{ role: 'user', content: 'Hi' }] });
const notify = (client, method, params) => client.emit('message', { method, params: { threadId: 'thread_test', ...params } });

test('isolates requests, filters commentary and does not duplicate authoritative final text', async () => {
  const { FakeClient, instances } = makeClient(client => {
    notify(client, 'item/started', { item: { id: 'progress', type: 'agentMessage', phase: 'commentary' } });
    notify(client, 'item/agentMessage/delta', { itemId: 'progress', delta: 'private progress' });
    notify(client, 'item/started', { item: { id: 'final', type: 'agentMessage', phase: 'final_answer' } });
    notify(client, 'item/agentMessage/delta', { itemId: 'final', delta: 'hello' });
    notify(client, 'item/completed', { item: { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'hello' } });
    notify(client, 'turn/completed', { turn: { status: 'completed' } });
  });
  const b = backend(FakeClient), deltas = [];
  const result = await b.complete(body(), { onDelta: d => deltas.push(d) });
  assert.equal(result.content, 'hello');
  assert.deepEqual(deltas, ['hello']);
  assert.equal(instances[0].closed, true);
  assert.equal(instances[0].requests[0].params.ephemeral, true);
  assert.deepEqual(instances[0].requests[0].params.environments, []);
});

test('returns a native tool request to the app without claiming to execute it', async () => {
  const { FakeClient, instances } = makeClient(client => client.emit('message', { id: 50, method: 'item/tool/call', params: {
    threadId: 'thread_test', turnId: 'turn_test', callId: 'call_1', tool: 'bridge_tool_0', arguments: { id: 'supplier-1' },
  } }));
  const b = backend(FakeClient);
  const result = await b.complete(validateRequest({ ...body(), tools: [{ type: 'function', function: { name: 'supplier_lookup' } }] }));
  assert.equal(result.tool_calls[0].function.name, 'supplier_lookup');
  assert.equal(result.finish_reason, 'tool_calls');
  assert.equal(instances[0].closed, true);
});

test('inference deadline rejects and closes the request process', async () => {
  const { FakeClient, instances } = makeClient(() => {});
  await assert.rejects(backend(FakeClient, 20).complete(body()), e => e.status === 504);
  assert.equal(instances[0].closed, true);
});

test('service shutdown rejects in-progress turns and releases child processes', async () => {
  let started;
  const turnStarted = new Promise(resolve => { started = resolve; });
  const { FakeClient, instances } = makeClient(started);
  const b = backend(FakeClient);
  const pending = b.complete(body());
  await turnStarted;
  b.close();
  await assert.rejects(pending, e => e instanceof ApiError && e.code === 'service_stopping');
  assert.equal(instances[0].closed, true);
});
