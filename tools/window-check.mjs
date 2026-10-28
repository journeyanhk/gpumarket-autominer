#!/usr/bin/env node
// 「窗口捕获」检查：利润的唯一来源是几个月才来一次的价格窗口。
// 判据（用户 2026-10-27 定的 KPI）：PRL 1 小时涨幅 ≥ +8% 时，10 分钟内必须已经出价。
//
// 用法：node tools/window-check.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';

const DATA = path.resolve(process.cwd(), 'data');
const st = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8')); } catch { return {}; } })();
const hist = (st.history || []).filter(h => Number(h.price) > 0);
const now = Date.now();
const last = hist.at(-1);
const at = ms => [...hist].reverse().find(h => h.t <= now - ms) || null;

const pct = (a, b) => (a > 0 && b > 0 ? +((b / a - 1) * 100).toFixed(2) : null);
const out = {
  price: last?.price ?? null,
  chg1h: pct(at(3600e3)?.price, last?.price),
  chg6h: pct(at(6 * 3600e3)?.price, last?.price),
  chg24h: pct(at(24 * 3600e3)?.price, last?.price),
  threshold1h: 8,
  instances: (st.managed ? Object.values(st.managed) : []).length,
};

// 出价时间点没有单独落盘，用"最近一次租用"的日志近似：直接看 events.log 里最近 10 分钟的自动租用
const logFile = path.join(DATA, 'events.log');
let rentInLast10 = 0;
try {
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-400);
  for (const line of lines) {
    if (!/自动租用|手动租用/.test(line)) continue;
    const m = line.match(/^\[(\d{4}-\d\d-\d\dT[\d:.]+Z?)\]/);
    if (m && now - Date.parse(m[1]) < 10 * 60e3) rentInLast10++;
  }
} catch { /* 没有日志就不判 */ }
out.rentInLast10Min = rentInLast10;
out.windowHit = out.chg1h != null && out.chg1h >= out.threshold1h;
out.captureOk = out.windowHit ? rentInLast10 > 0 : null;

if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

const f = v => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%');
console.log(`PRL $${out.price?.toFixed(4) ?? '—'} | 1h ${f(out.chg1h)} | 6h ${f(out.chg6h)} | 24h ${f(out.chg24h)}`);
if (out.windowHit) {
  console.log(out.captureOk ? '⚡ 窗口命中（1h ≥ +8%）且最近 10 分钟内有出价 → 捕获成功' : '⚠ 窗口命中（1h ≥ +8%）但最近 10 分钟没有出价 → 需要查为什么没抢');
} else {
  console.log(`窗口未命中（阈值 +8%/1h），当前在跑 ${out.instances} 台`);
}