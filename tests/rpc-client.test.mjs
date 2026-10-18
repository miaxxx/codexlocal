import test from 'node:test';
import assert from 'node:assert/strict';
import { RpcClient } from '../src/codex/rpc-client.mjs';
import { ApiError } from '../src/http/errors.mjs';

function clientWithAccountResponses(responses) {
  const client = Object.create(RpcClient.prototype);
  client.closed = false;
  client.calls = [];
  client.send = () => {};
  client.request = async (method) => {
    client.calls.push(method);
    if (method === 'initialize') return {};
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return client;
}

const timeout = () => new ApiError(502, 'workspace routing discovery timed out', 'codex_rpc_error');

test('retries transient routing discovery failures before checking the account', async () => {
  const client = clientWithAccountResponses([timeout(), timeout(), { account: { type: 'chatgpt' } }]);
  await client.initialize();
  assert.deepEqual(client.calls, ['initialize', 'account/read', 'account/read', 'account/read']);
});

test('limits retries and propagates other failures without retrying', async () => {
  const exhausted = clientWithAccountResponses([timeout(), timeout(), timeout()]);
  await assert.rejects(exhausted.initialize(), /workspace routing discovery timed out/);
  assert.equal(exhausted.calls.filter(call => call === 'account/read').length, 3);

  const failure = new ApiError(502, 'another failure', 'codex_rpc_error');
  const client = clientWithAccountResponses([failure]);
  await assert.rejects(client.initialize(), error => error === failure);
  assert.equal(client.calls.filter(call => call === 'account/read').length, 1);
});

test('continues to reject non-ChatGPT authentication after a retry', async () => {
  const client = clientWithAccountResponses([timeout(), { account: { type: 'apiKey' } }]);
  await assert.rejects(client.initialize(), error => error.code === 'chatgpt_login_required');
});
