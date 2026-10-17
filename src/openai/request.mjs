import { ApiError } from '../http/errors.mjs';

const invalid = (message, param) => { throw new ApiError(400, message, 'invalid_request', param); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function contentParts(content, role, param) {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') return [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: content }];
  if (!Array.isArray(content)) invalid('content 必须是文本或内容数组。', param);
  return content.map(part => {
    if (part?.type === 'text' && typeof part.text === 'string') {
      return { type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text };
    }
    if (part?.type === 'image_url' && role === 'user') {
      const url = part.image_url?.url;
      if (typeof url !== 'string' || !/^(https?:\/\/|data:image\/(png|jpeg|webp|gif);base64,)/.test(url)) {
        invalid('image_url 必须是 HTTP(S) URL 或图片 data URL。', param);
      }
      const detail = part.image_url.detail ?? 'auto';
      if (!['auto', 'low', 'high'].includes(detail)) invalid('无效的图片 detail。', param);
      return { type: 'input_image', image_url: url, detail };
    }
    invalid('仅支持 text 和用户消息中的 image_url 内容。', param);
  });
}

export function validateRequest(body) {
  if (!object(body)) invalid('请求体必须是 JSON 对象。', null);
  if (typeof body.model !== 'string' || !body.model) invalid('请填写模型 ID。', 'model');
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 1000) invalid('messages 必须包含 1–1000 条消息。', 'messages');
  for (const [index, message] of body.messages.entries()) {
    const p = `messages[${index}]`;
    if (!object(message) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) invalid('不支持该消息角色。', p);
    const parts = contentParts(message.content, message.role, p + '.content');
    if (message.role !== 'assistant' && !parts.length) invalid('消息内容不能为空。', p + '.content');
    if (message.role === 'tool' && (typeof message.tool_call_id !== 'string' || !message.tool_call_id)) invalid('工具结果必须有 tool_call_id。', p);
    if (message.tool_calls !== undefined) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) invalid('tool_calls 必须属于 assistant。', p);
      for (const call of message.tool_calls) {
        if (call?.type !== 'function' || typeof call.id !== 'string' || typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string') invalid('无效的历史工具调用。', p);
        try { JSON.parse(call.function.arguments); } catch { invalid('工具 arguments 必须是有效 JSON 字符串。', p); }
      }
    }
  }
  if (!['user', 'tool'].includes(body.messages.at(-1).role)) invalid('最后一条消息必须是 user 或 tool。', 'messages');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') invalid('stream 必须是布尔值。', 'stream');
  if (body.n !== undefined && body.n !== 1) invalid('此服务只支持 n=1。', 'n');
  if (body.functions !== undefined || body.function_call !== undefined) invalid('请改用 tools / tool_choice。', 'functions');
  const tools = body.tools ?? [];
  if (!Array.isArray(tools) || tools.length > 128) invalid('tools 必须是数组，最多 128 个。', 'tools');
  const names = new Set();
  for (const tool of tools) {
    if (tool?.type !== 'function' || typeof tool.function?.name !== 'string' || !tool.function.name || tool.function.name.length > 128) invalid('仅支持 function 工具。', 'tools');
    if (tool.function.description !== undefined && typeof tool.function.description !== 'string') invalid('工具 description 必须是字符串。', 'tools');
    if (tool.function.parameters !== undefined && !object(tool.function.parameters)) invalid('工具 parameters 必须是 JSON Schema 对象。', 'tools');
    if (names.has(tool.function.name)) invalid('工具名称不能重复。', 'tools');
    names.add(tool.function.name);
  }
  const choice = body.tool_choice ?? 'auto';
  if (typeof choice === 'string') {
    if (!['auto', 'none', 'required'].includes(choice)) invalid('不支持此 tool_choice。', 'tool_choice');
    if (choice === 'required' && !tools.length) invalid('required 需要至少一个工具。', 'tool_choice');
  } else if (!object(choice) || choice.type !== 'function' || !names.has(choice.function?.name)) {
    invalid('tool_choice 指定的工具不存在。', 'tool_choice');
  }
  if (body.reasoning_effort !== undefined && (typeof body.reasoning_effort !== 'string' || body.reasoning_effort === 'ultra')) invalid('请使用模型支持的推理强度；此桥接不支持自动委派模式 ultra。', 'reasoning_effort');
  const format = body.response_format;
  if (format && !['text', 'json_object', 'json_schema'].includes(format.type)) invalid('不支持此 response_format。', 'response_format');
  if (format?.type === 'json_schema' && !object(format.json_schema?.schema)) invalid('请提供 json_schema.schema。', 'response_format');
  if (format?.type === 'json_schema' && tools.length && choice !== 'none') invalid('暂不支持同时指定 json_schema 和可调用工具。', 'response_format');
  return { ...body, tools, tool_choice: choice, stream: body.stream ?? false };
}

export function prepareConversation(body) {
  const offered = body.tool_choice === 'none' ? [] : body.tools.filter(tool => typeof body.tool_choice === 'string' || tool.function.name === body.tool_choice.function.name);
  const nameMap = new Map(body.tools.map((t, i) => [t.function.name, `bridge_tool_${i}`]));
  const dynamicTools = offered.map(t => ({
    type: 'function', name: nameMap.get(t.function.name), description: `${t.function.name}: ${t.function.description ?? ''}`,
    inputSchema: t.function.parameters ?? { type: 'object', properties: {}, additionalProperties: false },
  }));
  const reverseNames = new Map(offered.map(t => [nameMap.get(t.function.name), t.function.name]));
  const systems = [], developers = [], history = [];
  for (const message of body.messages) {
    const parts = contentParts(message.content, message.role, 'messages.content');
    if (message.role === 'system' || message.role === 'developer') {
      (message.role === 'system' ? systems : developers).push(parts.map(p => p.text).join('\n'));
    } else if (message.role === 'tool') {
      history.push({ type: 'function_call_output', call_id: message.tool_call_id, output: parts.map(p => p.text).join('\n') });
    } else {
      if (parts.length) history.push({ type: 'message', role: message.role, content: parts });
      for (const call of message.tool_calls ?? []) {
        history.push({ type: 'function_call', call_id: call.id, name: nameMap.get(call.function.name) ?? call.function.name, arguments: call.function.arguments });
      }
    }
  }
  const last = body.messages.at(-1);
  let input;
  if (last.role === 'user') {
    const item = history.pop();
    input = item.content.map(p => p.type === 'input_image' ? { type: 'image', url: p.image_url, detail: p.detail } : { type: 'text', text: p.text });
  } else {
    input = [{ type: 'text', text: 'Continue the conversation using the preceding tool results. Return the next assistant response.' }];
  }
  const requireTool = body.tool_choice === 'required' || typeof body.tool_choice === 'object';
  const bridgeInstructions = [
    'You are the assistant behind a local Chat Completions test bridge. Answer the conversation directly.',
    'Use only the supplied bridge_tool_* function tools. Never run shell commands, edit files, access local files, use built-in tools, or delegate work.',
    'Tool implementations belong to the calling app. Choose a tool when appropriate; never invent its result. Call at most one tool before waiting for its result.',
    'Do not emit progress commentary. Put user-facing text in the final answer, or call an offered function tool.',
    requireTool ? 'You MUST call one of the supplied function tools in this response.' : '',
    body.response_format?.type === 'json_object' ? 'Return a valid JSON object as your final answer.' : '',
  ].filter(Boolean).join('\n');
  return {
    baseInstructions: systems.join('\n\n') || 'You are a helpful assistant.',
    developerInstructions: [...developers, bridgeInstructions].join('\n\n'),
    dynamicTools, reverseNames, history, input, requireTool,
    outputSchema: body.response_format?.type === 'json_schema' ? body.response_format.json_schema.schema : undefined,
  };
}
