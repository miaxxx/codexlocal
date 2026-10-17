import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const runtime = join(root, '.runtime');

async function findCodex() {
  const candidates = process.env.BRIDGE_CODEX_BIN ? [process.env.BRIDGE_CODEX_BIN] : [
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    ...(process.env.PATH ?? '').split(':').map(p => join(p, 'codex')),
  ];
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return resolve(candidate); } catch {}
  }
  throw new Error('找不到 Codex CLI。请设置 BRIDGE_CODEX_BIN 为 CLI 的绝对路径。');
}

function positiveInteger(value, fallback, max) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error('服务配置必须是有效的正整数。');
  return n;
}

export async function loadSettings() {
  await mkdir(join(runtime, 'workspace'), { recursive: true, mode: 0o700 });
  let apiKey = process.env.BRIDGE_API_KEY;
  if (!apiKey) {
    const path = join(runtime, 'api-key');
    try { apiKey = (await readFile(path, 'utf8')).trim(); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      apiKey = `local-${randomBytes(24).toString('hex')}`;
      try { await writeFile(path, apiKey + '\n', { mode: 0o600, flag: 'wx' }); }
      catch (e) { if (e.code !== 'EEXIST') throw e; apiKey = (await readFile(path, 'utf8')).trim(); }
    }
  }
  if (apiKey.length < 12) throw new Error('BRIDGE_API_KEY 至少需要 12 个字符。');
  return {
    root, runtime, apiKey,
    host: '127.0.0.1',
    port: positiveInteger(process.env.BRIDGE_PORT, 8787, 65535),
    timeoutMs: positiveInteger(process.env.BRIDGE_TIMEOUT_MS, 180000, 1800000),
    maxConcurrent: positiveInteger(process.env.BRIDGE_MAX_CONCURRENT, 2, 8),
    bodyLimit: 16 * 1024 * 1024,
    codexBin: await findCodex(),
    cwd: join(runtime, 'workspace'),
    model: process.env.BRIDGE_MODEL || null,
    alias: 'codex-local',
  };
}
