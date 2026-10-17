import { randomUUID } from 'node:crypto';

export function identity(model) {
  return { id: `chatcmpl-${randomUUID().replaceAll('-', '')}`, created: Math.floor(Date.now() / 1000), model };
}

export function completion(meta, result) {
  const message = { role: 'assistant', content: result.content };
  if (result.tool_calls) message.tool_calls = result.tool_calls;
  return { ...meta, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: result.finish_reason }], ...(result.usage ? { usage: result.usage } : {}) };
}

export function chunk(meta, delta, finishReason = null) {
  return { ...meta, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

export function streamResult(meta, result, includeUsage, send) {
  if (result.tool_calls) {
    send(chunk(meta, { tool_calls: result.tool_calls.map((call, index) => ({ index, ...call })) }));
  }
  send(chunk(meta, {}, result.finish_reason));
  if (includeUsage && result.usage) send({ ...meta, object: 'chat.completion.chunk', choices: [], usage: result.usage });
}
