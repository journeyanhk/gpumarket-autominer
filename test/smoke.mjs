#!/usr/bin/env node
// 线上冒烟测试（2026-11-04）：单元测试抓不到「作用域里的 med 解析错」「缓存字段缺 CPU」这类 bug，
// 必须真的把 server.js 拉起来、真的 GET /api/state、真的看 pricingTable 里有没有值。
//
// 设计约束：
//  - 全程离线可跑：种子 state.json 自带 offersCache，启动时 loadOffers() 就能填满报价。
//  - 绝不租机：种子配置 autoRent=false，且只读接口。
//  - 用临时目录 + 独立端口，不碰生产 data/ 与 8290。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prl-smoke-'));
const port = 8300 + Math.floor(Math.random() * 90);

let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed++; console.log(`  ✗ ${msg}`); } };

const rows = [
  { id: 1, machineId: 91001, gpuName: 'RTX 2080 Ti', numGpus: 1, dph: 0.0561, listDph: 0.0561, minBid: 0.0561, spot: true, reliability: 0.99, geolocation: 'Norway, NO', inetDown: 900, cuda: 12.4, source: 'spot', autoOk: true, l1: 0.72, hostId: 91001, cpu_cores: 24, cpu_cores_effective: 12, cpu_ram: 16006 },
  { id: 2, machineId: 91002, gpuName: 'RTX 4070 Ti Super', numGpus: 1, dph: 0.089, listDph: 0.089, minBid: 0.089, spot: true, reliability: 0.99, geolocation: 'Poland, PL', inetDown: 800, cuda: 12.4, source: 'spot', autoOk: true, l1: 0.8, hostId: 91002, cpu_cores: 64, cpu_cores_effective: 24, cpu_ram: 16000 },
  { id: 3, machineId: 91003, gpuName: 'RTX 3080', numGpus: 1, dph: 0.0933, listDph: 0.0933, minBid: 0.0933, spot: true, reliability: 0.98, geolocation: 'Japan, JP', inetDown: 700, cuda: 12.4, source: 'spot', autoOk: true, l1: 0.5, hostId: 91003, cpu_cores: 56, cpu_cores_effective: 28, cpu_ram: 64000 },
];

fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
// 配置与状态是两个文件：config.json 决定端口，state.json 只放状态（2026-11-04 踩过）
fs.writeFileSync(path.join(dir, 'data', 'config.json'), JSON.stringify({ port, autoRent: false }, null, 2));
fs.writeFileSync(path.join(dir, 'data', 'state.json'), JSON.stringify({
  offersCache: { at: Date.now(), rows },
}, null, 2));

console.log(`线上冒烟：临时目录 ${dir}，端口 ${port}`);
const child = spawn(process.execPath, [path.join(root, 'server.js')], { cwd: dir, env: { ...process.env, PRL_HOME: dir, PRL_NO_BROWSER: '1', PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', d => { stderr += d.toString(); });

const wait = ms => new Promise(r => setTimeout(r, ms));
let state = null;
for (let i = 0; i < 40; i++) {
  await wait(500);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) { state = await r.json(); break; }
    if (r.status >= 400) { const t = await r.text(); stderr += ` HTTP ${r.status} ${t}`; break; }
  } catch { /* 还在启动 */ }
}

ok(!!state, 'GET /api/state 返回 200 且能解析');
if (state) {
  const table = state.pricingTable || [];
  const offers = state.offers || [];
  ok(table.length > 0, `pricingTable 有 ${table.length} 行`);
  ok(offers.length > 0, `offers 有 ${offers.length} 条`);
  const keys = ['effThreads', 'usableThreads', 'ramMb', 'cpuLegUsdHr', 'threadsNeeded', 'shadowExpRoi', 'ramLimited'];
  const missing = keys.filter(k => table.length > 0 && !(k in table[0]));
  ok(missing.length === 0, `pricingTable 行含全部影子列${missing.length ? `（缺 ${missing.join(',')}）` : ''}`);
  ok(table.some(r => Number(r.effThreads) > 0), 'effThreads 至少一行有值（缓存字段没丢）');
  ok(table.some(r => Number(r.cpuLegUsdHr) > 0), 'cpuLegUsdHr 至少一行 > 0');
  ok(offers.every(o => 'effThreads' in o && 'cpuLegUsdHr' in o), '每条报价都带 CPU 影子字段');
  ok(state.config?.cpuLeg?.pricingEnabled === false, '定价开关仍关闭（影子模式不得影响出价）');
  // RAM 门控必须真的生效：24 线程 + 16GB 的那台只能算 8 线程
  const rammed = offers.find(o => o.machineId === 91002);
  // 16000MB 是 vast 的十进制标称（≈15.6GiB）→ 15.6÷2 取整 7 线程；不是 8，
  // 因为按 2GiB/线程算 8 线程要 16.0GiB，那台机器并不够。宁可少算一档。
  if (rammed) ok(Number(rammed.usableThreads?.threads) === 7, `24 核/16000MB 的机器算出 ${rammed.usableThreads?.threads} 线程（应为 7）`);
  else ok(true, '（该机器这轮没进报价池，跳过 RAM 门控断言）');
}

child.kill('SIGKILL');
await wait(300);
fs.rmSync(dir, { recursive: true, force: true });
if (stderr.trim()) console.log('  · server stderr:', stderr.trim().split('\n').slice(0, 3).join(' | '));
console.log(failed ? `\n冒烟失败：${failed} 项` : '\n冒烟通过');
process.exit(failed ? 1 : 0);