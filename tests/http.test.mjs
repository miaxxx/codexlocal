import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApiServer } from '../src/http/server.mjs';
import { ApiError } from '../src/http/errors.mjs';

async function fixture(t, complete) {
  const backend = { defaultModel: 'fake', models: [{ model: 'fake' }], resolveModel() {}, complete: complete ?? (async (_, { onDelta }) => { onDelta('hello'); return { content: 'hello', finish_reason: 'stop' }; }) };
  const server = createApiServer({ apiKey: 'test-local-api-key', alias: 'codex-local', maxConcurrent: 1, bodyLimit: 1024 }, backend, { log() {} });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: 'Bearer test-local-api-key', 'Content-Type': 'application/json' };
  const post = body => fetch(url + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: 'codex-local', messages: [{ role: 'user', content: 'Hi' }], ...body }) });
  return { url, post, headers };
}

test('requires local key and rejects external browser origins', async t => {
  const { url, headers } = await fixture(t);
  assert.equal((await fetch(url + '/v1/models')).status, 401);
  assert.equal((await fetch(url + '/v1/models', { headers })).status, 200);
  assert.equal((await fetch(url + '/v1/models', { headers: { ...headers, Origin: 'https://attacker.example' } })).status, 403);
  const preflight = await fetch(url + '/v1/models', { method: 'OPTIONS', headers: { Origin: 'null' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'null');
});

test('supports standard non-stream and SSE completion contracts', async t => {
  const { post } = await fixture(t);
  const normal = await (await post({})).json();
  assert.equal(normal.choices[0].message.content, 'hello');
  const stream = await (await post({ stream: true })).text();
  assert.match(stream, /"role":"assistant"/);
  assert.match(stream, /"content":"hello"/);
  assert.match(stream, /"finish_reason":"stop"/);
  assert.ok(stream.endsWith('data: [DONE]\n\n'));
});

test('returns inference failure as SSE error without a false successful finish', async t => {
  const { post } = await fixture(t, async () => { throw new ApiError(504, 'Timeout', 'inference_timeout'); });
  const stream = await (await post({ stream: true })).text();
  assert.match(stream, /inference_timeout/);
  assert.doesNotMatch(stream, /"finish_reason":"stop"/);
});

test('malformed and oversized payloads return HTTP errors without invoking inference', async t => {
  let invoked = false;
  const { url, headers } = await fixture(t, async () => { invoked = true; });
  const invalid = await fetch(url + '/v1/chat/completions', { method: 'POST', headers, body: '{broken' });
  assert.equal(invalid.status, 400);
  const oversized = await fetch(url + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ content: 'a'.repeat(2048) }) });
  assert.equal(oversized.status, 413);
  assert.equal(invoked, false);
});

test('limits concurrency and cancels backend when HTTP client disconnects', async t => {
  let began;
  const running = new Promise(resolve => { began = resolve; });
  let cancelled;
  const stopped = new Promise(resolve => { cancelled = resolve; });
  const { url, post, headers } = await fixture(t, (_, { signal }) => new Promise((_, reject) => {
    began();
    signal.addEventListener('abort', () => { cancelled(); reject(new ApiError(499, 'Cancelled', 'request_cancelled')); }, { once: true });
  }));
  const controller = new AbortController();
  const pending = fetch(url + '/v1/chat/completions', { method: 'POST', headers, signal: controller.signal, body: JSON.stringify({ model: 'codex-local', messages: [{ role: 'user', content: 'Hi' }] }) }).catch(() => {});
  await running;
  assert.equal((await post({})).status, 429);
  controller.abort();
  await stopped;
  await pending;
});
