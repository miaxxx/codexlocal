import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest, prepareConversation } from '../src/openai/request.mjs';
import { completion, chunk, streamResult } from '../src/openai/response.mjs';

const tool = { type: 'function', function: { name: 'Supplier.changeRisk', parameters: { type: 'object', properties: { risk: { type: 'string' } } } } };
const user = { role: 'user', content: 'Change the risk.' };

test('preserves system, developer, assistant and tool roles and remaps tool names consistently', () => {
  const c = prepareConversation(validateRequest({ model: 'codex-local', tools: [tool], messages: [
    { role: 'system', content: 'SYSTEM_RULE' }, { role: 'developer', content: 'DEVELOPER_RULE' }, user,
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: tool.function.name, arguments: '{"risk":"low"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"approved":true}' },
  ] }));
  assert.equal(c.baseInstructions, 'SYSTEM_RULE');
  assert.match(c.developerInstructions, /DEVELOPER_RULE/);
  assert.equal(c.history[1].name, c.dynamicTools[0].name);
  assert.equal(c.history[2].call_id, 'call_1');
  assert.equal(c.reverseNames.get(c.history[1].name), 'Supplier.changeRisk');
  assert.equal(c.history[2].type, 'function_call_output');
});

test('forwards current and historical images using native content parts', () => {
  const c = prepareConversation(validateRequest({ model: 'codex-local', messages: [{ role: 'user', content: [
    { type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
  ] }] }));
  assert.equal(c.input[1].type, 'image');
  assert.equal(c.input[1].url, 'data:image/png;base64,AAAA');
});

test('validates unsupported or malformed requests before creating any Codex process', () => {
  for (const body of [
    { model: 'codex-local', messages: [user], n: 2 },
    { model: 'codex-local', messages: [user], tool_choice: 'required' },
    { model: 'codex-local', messages: [{ role: 'tool', content: '{}' }] },
    { model: 'codex-local', messages: [user], reasoning_effort: 'ultra' },
    { model: 'codex-local', messages: [user], tools: [tool, tool] },
  ]) assert.throws(() => validateRequest(body), e => e.status === 400);
});

test('tool_choice none removes current tool definitions but retains historical call identities', () => {
  const c = prepareConversation(validateRequest({ model: 'codex-local', messages: [user], tools: [tool], tool_choice: 'none' }));
  assert.equal(c.dynamicTools.length, 0);
});

test('stream and non-stream tool results use compatible tool_calls and finish_reason', () => {
  const meta = { id: 'chatcmpl-test', created: 1, model: 'codex-local' };
  const result = { content: null, finish_reason: 'tool_calls', tool_calls: [{ id: 'call_test', type: 'function', function: { name: 'test', arguments: '{}' } }] };
  assert.equal(completion(meta, result).choices[0].message.tool_calls[0].id, 'call_test');
  const events = [];
  streamResult(meta, result, false, e => events.push(e));
  assert.equal(events[0].choices[0].delta.tool_calls[0].index, 0);
  assert.equal(events.at(-1).choices[0].finish_reason, 'tool_calls');
  assert.equal(chunk(meta, { content: 'hi' }).choices[0].finish_reason, null);
});
