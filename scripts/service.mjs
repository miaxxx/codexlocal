import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { loadSettings } from '../src/config/settings.mjs';
import { join } from 'node:path';

const settings = await loadSettings();
const url = `http://${settings.host}:${settings.port}`;
async function health() {
  try { return await (await fetch(url + '/health', { signal: AbortSignal.timeout(1500) })).json(); }
  catch { return null; }
}
const command = process.argv[2];
if (command === 'status') {
  const current = await health();
  console.log(current ? JSON.stringify(current, null, 2) : '服务未运行。');
  if (!current) process.exitCode = 1;
} else if (command === 'stop') {
  const current = await health();
  if (!current) console.log('服务未运行。');
  else {
    if (current.backend !== 'codex-app-server') throw new Error('此端口不是本项目的服务。');
    const response = await fetch(url + '/internal/shutdown', { method: 'POST', headers: { Authorization: `Bearer ${settings.apiKey}` }, signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error('停止失败：本地服务身份验证未通过。');
    for (let i = 0; i < 30 && await health(); i++) await delay(100);
    console.log('服务已停止。');
  }
} else if (command === 'start') {
  if (await health()) throw new Error('端口已有服务运行。请使用 service:status 查看。');
  const logfile = await open(join(settings.runtime, 'service.log'), 'a', 0o600);
  const child = spawn(process.execPath, [join(settings.root, 'src/main.mjs')], {
    cwd: settings.root, env: process.env, detached: true, stdio: ['ignore', logfile.fd, logfile.fd],
  });
  let launchError;
  child.on('error', e => { launchError = e; });
  child.unref();
  await logfile.close();
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (launchError) throw launchError;
    const current = await health();
    if (current?.pid === child.pid && current.backend === 'codex-app-server') { ready = true; break; }
    if (child.exitCode !== null) break;
    await delay(500);
  }
  if (!ready) throw new Error(`启动失败。请检查 ${join(settings.runtime, 'service.log')}`);
  console.log(`服务在后台运行：${url}/v1`);
  console.log(`连接参数：${join(settings.root, 'CONNECTION.txt')}`);
} else throw new Error('用法：node scripts/service.mjs start|stop|status');
