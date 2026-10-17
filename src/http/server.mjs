import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { ApiError, errorBody, json } from './errors.mjs';
import { validateRequest } from '../openai/request.mjs';
import { identity, completion, chunk, streamResult } from '../openai/response.mjs';

function authorized(req, key) {
  const provided = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${key}`);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function allowOrigin(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  if (!['null', 'dsh-app://app'].includes(origin) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    throw new ApiError(403, '此服务只允许本地应用访问。', 'origin_not_allowed');
  }
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}

async function readBody(req, limit) {
  const buffers = [];
  let size = 0;
  for await (const buffer of req.iterator({ destroyOnReturn: false })) {
    size += buffer.length;
    if (size > limit) { req.resume(); throw new ApiError(413, '请求超过服务大小限制。', 'body_too_large'); }
    buffers.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(buffers).toString('utf8')); }
  catch { throw new ApiError(400, '请求体不是有效 JSON。', 'invalid_json'); }
}

export function createApiServer(settings, backend, { onShutdown = () => {}, log = console.log } = {}) {
  let active = 0;
  const server = createServer(async (req, res) => {
    const startedAt = Date.now();
    let heartbeat, acquired = false;
    const controller = new AbortController();
    const aborted = () => controller.abort();
    req.on('aborted', aborted);
    res.on('close', () => { if (!res.writableEnded) aborted(); });
    const send = payload => {
      if (res.destroyed || res.writableEnded) return;
      if (res.writableLength > 4 * 1024 * 1024) throw new ApiError(503, '客户端读取流过慢。', 'slow_client');
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const finishStream = () => { if (!res.destroyed && !res.writableEnded) res.end('data: [DONE]\n\n'); };
    try {
      allowOrigin(req, res);
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (req.method === 'GET' && path === '/health') {
        json(res, 200, { status: 'ok', pid: process.pid, backend: 'codex-app-server', auth: 'chatgpt', model: backend.defaultModel, active });
        return;
      }
      if (!authorized(req, settings.apiKey)) throw new ApiError(401, '本地 API Key 不正确。', 'invalid_api_key');
      if (req.method === 'POST' && path === '/internal/shutdown') {
        json(res, 200, { status: 'stopping' });
        setImmediate(onShutdown);
        return;
      }
      if (req.method === 'GET' && path === '/v1/models') {
        const models = [settings.alias, ...backend.models.map(m => m.model)];
        json(res, 200, { object: 'list', data: models.map(id => ({ id, object: 'model', created: 0, owned_by: 'codex-local' })) });
        return;
      }
      if (req.method !== 'POST' || path !== '/v1/chat/completions') throw new ApiError(404, '此服务提供 /v1/models 和 /v1/chat/completions。', 'route_not_found');
      if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw new ApiError(415, '请使用 Content-Type: application/json。', 'unsupported_media_type');
      if (active >= settings.maxConcurrent) {
        res.setHeader('Retry-After', '2');
        throw new ApiError(429, '本地 Codex 并发已满，请稍后重试。', 'local_concurrency_limit');
      }
      active++;
      acquired = true;
      const body = validateRequest(await readBody(req, settings.bodyLimit));
      backend.resolveModel(body);
      const ignored = ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'stop', 'seed', 'frequency_penalty', 'presence_penalty', 'logprobs', 'parallel_tool_calls'].filter(k => body[k] !== undefined);
      if (ignored.length) res.setHeader('X-Codex-Ignored-Parameters', ignored.join(','));
      const meta = identity(body.model);
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        send(chunk(meta, { role: 'assistant', content: '' }));
        heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n'); }, 15000);
      }
      const result = await backend.complete(body, {
        signal: controller.signal,
        onDelta: text => { if (body.stream) send(chunk(meta, { content: text })); },
      });
      if (body.stream) { streamResult(meta, result, body.stream_options?.include_usage, send); finishStream(); }
      else json(res, 200, completion(meta, result));
      log(JSON.stringify({ request: meta.id, status: 200, finish: result.finish_reason, ms: Date.now() - startedAt }));
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, errorBody(error));
      else if (!res.destroyed && !res.writableEnded) { send(errorBody(error)); finishStream(); }
      log(JSON.stringify({ status: error.status || 500, code: error.code || 'bridge_error', ms: Date.now() - startedAt }));
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      req.off('aborted', aborted);
      if (acquired) active--;
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  return server;
}
