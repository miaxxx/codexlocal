import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSettings } from './config/settings.mjs';
import { CodexBackend } from './codex/backend.mjs';
import { createApiServer } from './http/server.mjs';

const settings = await loadSettings();
const backend = new CodexBackend(settings);
let server, stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  backend.close();
  if (server) { server.close(() => process.exit(0)); server.closeAllConnections(); }
  else process.exit(0);
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  await backend.catalog();
  server = createApiServer(settings, backend, { onShutdown: shutdown });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(settings.port, settings.host, resolve);
  });
  await writeFile(join(settings.root, 'CONNECTION.txt'), [
    'Orbis 大模型 API 设置',
    'API 协议: OpenAI Chat Completions',
    `Base URL: http://${settings.host}:${settings.port}/v1`,
    `模型 ID: ${settings.alias}`,
    `API Key: ${settings.apiKey}`,
    `当前实际模型: ${backend.defaultModel}`,
    'Computer Use: 初次测试先关闭；此服务只转发客户端提供的函数工具。',
    '模型仍在 Codex 云端运行，使用已登录 ChatGPT 账户的 Codex 配额。',
    '不要填写 ChatGPT 登录令牌或付费 OpenAI API Key。',
    '',
  ].join('\n'), { mode: 0o600 });
  console.log(`本地服务已启动：http://${settings.host}:${settings.port}/v1`);
  console.log(`ChatGPT 登录已确认；模型：${backend.defaultModel}`);
  console.log(`软件连接参数已保存：${join(settings.root, 'CONNECTION.txt')}`);
} catch (error) {
  backend.close();
  console.error(`启动失败：${error.message}`);
  process.exitCode = 1;
  if (server?.listening) server.close();
}
