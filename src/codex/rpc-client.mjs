import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { ApiError } from '../http/errors.mjs';

// One isolated stdio process per HTTP request. No shared conversation or pending tool state.
export class RpcClient extends EventEmitter {
  constructor(settings) {
    super();
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    const env = { ...process.env };
    // Never switch this local-test bridge to metered API authentication through inherited env vars.
    for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL']) delete env[name];
    const overrides = [
      'model_provider="openai"', 'features.plugins=false', 'features.apps=false',
      'features.shell_tool=false', 'features.unified_exec=false',
      'features.multi_agent=false', 'features.computer_use=false',
      'features.memories=false', 'features.hooks=false',
      'web_search="disabled"', 'project_doc_max_bytes=0', 'mcp_servers={}',
    ];
    this.child = spawn(settings.codexBin, [
      ...overrides.flatMap(value => ['-c', value]), 'app-server', '--listen', 'stdio://',
    ], { cwd: settings.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    // Upstream diagnostic output can contain private data; never put it in the HTTP log.
    this.child.stderr.resume();
    this.child.stdin.on('error', error => this.fail(new ApiError(502, error.message, 'codex_pipe_error')));
    this.child.on('error', error => this.fail(new ApiError(502, `Codex 启动失败：${error.message}`, 'codex_start_failed')));
    this.child.on('exit', (code, signal) => {
      if (!this.closed) this.fail(new ApiError(502, `Codex 进程提前结束 (${signal || code})`, 'codex_exit'));
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); }
      catch { this.fail(new ApiError(502, 'Codex 返回了无效的 JSON-RPC 消息。', 'codex_protocol_error')); return; }
      if (!message.method && message.id !== undefined) {
        const p = this.pending.get(message.id);
        if (!p) return;
        this.pending.delete(message.id);
        clearTimeout(p.timer);
        message.error ? p.reject(new ApiError(502, message.error.message, 'codex_rpc_error')) : p.resolve(message.result);
      } else {
        this.emit('message', message);
      }
    });
  }

  send(message) {
    if (this.closed) throw new ApiError(502, 'Codex 连接已关闭。', 'codex_closed');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method, params, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new ApiError(502, 'Codex 连接已关闭。', 'codex_closed'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ApiError(504, `Codex ${method} 超时。`, 'codex_rpc_timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'codex_local_bridge', title: 'Local Chat Completions Bridge', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized' });
    const account = await this.request('account/read', { refreshToken: false });
    if (account.account?.type !== 'chatgpt') {
      throw new ApiError(503, '需要 Codex 的 ChatGPT 登录状态。请使用此 CLI 执行 login；此服务拒绝 API Key 计费模式。', 'chatgpt_login_required');
    }
  }

  fail(error) {
    if (this.closed) return;
    this.emit('failure', error);
    this.close(error);
  }

  close(error = new ApiError(499, '请求已取消。', 'request_cancelled')) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.lines.close();
    this.child.stdin.destroy();
    this.child.kill('SIGTERM');
    const force = setTimeout(() => { if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL'); }, 1500);
    force.unref();
  }
}
