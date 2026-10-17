import { RpcClient } from './rpc-client.mjs';
import { prepareConversation } from '../openai/request.mjs';
import { ApiError } from '../http/errors.mjs';

export class CodexBackend {
  constructor(settings, Client = RpcClient) { this.settings = settings; this.Client = Client; this.active = new Set(); }

  async catalog() {
    const client = new this.Client(this.settings);
    this.active.add(client);
    try {
      await client.initialize();
      let cursor = null;
      const models = [];
      do {
        const page = await client.request('model/list', { includeHidden: false, cursor, limit: 100 });
        models.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor);
      this.models = models;
      this.defaultModel = this.settings.model || models.find(m => m.isDefault)?.model || models[0]?.model;
      if (!models.some(m => m.model === this.defaultModel)) throw new ApiError(503, '默认模型不在当前 Codex 账户的模型目录中。', 'model_unavailable');
      return models;
    } finally { client.close(); this.active.delete(client); }
  }

  resolveModel(body) {
    const model = body.model === this.settings.alias ? this.defaultModel : body.model;
    const entry = this.models?.find(m => m.model === model);
    if (!entry) throw new ApiError(400, '模型不在当前 Codex 目录中，请查询 /v1/models。', 'model_not_found', 'model');
    const effort = body.reasoning_effort ?? 'low';
    if (!entry.supportedReasoningEfforts.some(e => e.reasoningEffort === effort)) throw new ApiError(400, '此模型不支持该 reasoning_effort。', 'unsupported_reasoning_effort', 'reasoning_effort');
    return { model, effort };
  }

  async complete(body, { signal, onDelta = () => {} } = {}) {
    const { model, effort } = this.resolveModel(body);
    const conversation = prepareConversation(body);
    const client = new this.Client(this.settings);
    this.active.add(client);
    const cancelled = () => client.close(new ApiError(499, '客户端取消了请求。', 'request_cancelled'));
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) cancelled();
    const timer = setTimeout(() => client.fail(new ApiError(504, 'Codex 推理超时。', 'inference_timeout')), this.settings.timeoutMs);
    try {
      await client.initialize();
      const started = await client.request('thread/start', {
        model, modelProvider: 'openai', cwd: this.settings.cwd,
        ephemeral: true, environments: [], sandbox: 'read-only', approvalPolicy: 'never',
        baseInstructions: conversation.baseInstructions,
        developerInstructions: conversation.developerInstructions,
        dynamicTools: conversation.dynamicTools,
      });
      const threadId = started.thread.id;
      if (conversation.history.length) await client.request('thread/inject_items', { threadId, items: conversation.history });
      return await this.runTurn(client, threadId, body, conversation, effort, onDelta, signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancelled);
      client.close();
      this.active.delete(client);
    }
  }

  runTurn(client, threadId, body, conversation, effort, onDelta, signal) {
    return new Promise((resolve, reject) => {
      const messages = new Map();
      let usage = null, finished = false;
      const finish = (error, result) => {
        if (finished) return;
        finished = true;
        client.off('message', handle);
        client.off('failure', failed);
        signal?.removeEventListener('abort', aborted);
        error ? reject(error) : resolve(result);
      };
      const failed = error => finish(error);
      const aborted = () => finish(new ApiError(499, '请求已取消。', 'request_cancelled'));
      const handle = event => {
        try {
          const p = event.params ?? {};
          if (p.threadId && p.threadId !== threadId) return;
          if (event.id !== undefined && event.method) {
            if (event.method !== 'item/tool/call' || !conversation.reverseNames.has(p.tool)) {
              finish(new ApiError(502, `Codex 请求了桥接范围外的操作：${event.method}`, 'unexpected_codex_tool'));
              return;
            }
            const call = { id: p.callId, type: 'function', function: { name: conversation.reverseNames.get(p.tool), arguments: JSON.stringify(p.arguments) } };
            // Ending this isolated process cancels the pending call. The app executes it and
            // sends assistant/tool messages in its next stateless Chat Completions request.
            finish(null, { content: null, tool_calls: [call], finish_reason: 'tool_calls', usage });
            return;
          }
          if (event.method === 'item/started' && p.item.type === 'agentMessage') {
            messages.set(p.item.id, { phase: p.item.phase, text: '', streamed: false });
          } else if (event.method === 'item/agentMessage/delta') {
            const item = messages.get(p.itemId) ?? { phase: null, text: '', streamed: false };
            item.text += p.delta;
            if (item.phase !== 'commentary') { item.streamed = true; onDelta(p.delta); }
            messages.set(p.itemId, item);
          } else if (event.method === 'item/completed' && p.item.type === 'agentMessage') {
            const item = messages.get(p.item.id) ?? { streamed: false };
            if (!item.streamed && p.item.phase !== 'commentary') onDelta(p.item.text);
            messages.set(p.item.id, { ...item, phase: p.item.phase, text: p.item.text });
          } else if (event.method === 'thread/tokenUsage/updated') {
            const u = p.tokenUsage.total;
            usage = { prompt_tokens: u.inputTokens, completion_tokens: u.outputTokens, total_tokens: u.totalTokens,
              prompt_tokens_details: { cached_tokens: u.cachedInputTokens }, completion_tokens_details: { reasoning_tokens: u.reasoningOutputTokens } };
          } else if (event.method === 'turn/completed') {
            if (p.turn.status !== 'completed') {
              finish(new ApiError(502, p.turn.error?.message || `Codex turn ${p.turn.status}`, 'codex_turn_failed'));
              return;
            }
            if (conversation.requireTool) { finish(new ApiError(502, 'Codex 没有满足 required 工具调用约束。', 'tool_choice_unsatisfied')); return; }
            const content = [...messages.values()].filter(m => m.phase !== 'commentary').map(m => m.text).join('\n');
            if (body.response_format?.type === 'json_object') {
              let parsed;
              try { parsed = JSON.parse(content); } catch { throw new ApiError(502, 'Codex 返回的内容不是有效 JSON。', 'invalid_json_output'); }
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ApiError(502, 'Codex 返回的内容不是 JSON 对象。', 'invalid_json_output');
            }
            finish(null, { content, finish_reason: 'stop', usage });
          }
        } catch (error) { finish(error); }
      };
      client.on('message', handle);
      client.on('failure', failed);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted || client.closed) { aborted(); return; }
      client.request('turn/start', { threadId, input: conversation.input, effort, summary: 'none', outputSchema: conversation.outputSchema }).catch(failed);
    });
  }

  close() { for (const client of this.active) client.fail(new ApiError(503, '本地服务正在停止。', 'service_stopping')); this.active.clear(); }
}
