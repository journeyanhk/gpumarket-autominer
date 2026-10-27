#!/usr/bin/env node
// 多场地比价（只读）：vast / Clore / RunPod 的租卡价 vs 当前盈亏线。
// 目的：回答"今天到底有没有地方能买到低于盈亏线的算力"，而不是只盯着 vast。
//
// 用法：node tools/venue-compare.mjs [--json] [--models RTX3090,RTX4090]
import fs from 'node:fs';
import { Vast } from '../src/vast.js';
import { hashrateTable, gpuKey } from '../src/gpus.js';
import { loadConfig } from '../src/store.js';

const SEC = '/data/prl-automine/.secrets';
const argv = process.argv.slice(2);
const has = k => argv.includes(`--${k}`);
const arg = k => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null; };

const readEnv = f => { try { return Object.fromEntries(fs.readFileSync(f, 'utf8').trim().split('\n').filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; })); } catch { return {}; } };
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const medianOrNull = a => (a.length ? median(a) : null); // 样本少的也显示，但会标注 n

const table = hashrateTable();
// 复用项目里的型号归一（会保留 RTX 前缀并处理 SUPER/Ti 后缀），别自己写一套
const modelOf = name => table.find(g => g.key === gpuKey(name)) || null;

// 当前收入密度（用项目里的三源逻辑）
const st = await (await fetch('http://127.0.0.1:8290/api/state')).json().catch(() => null);
const density = st?.market?.usdPerThDay;
const price = st?.market?.price;
const sourceName = st?.market?.sourceName;
if (!(density > 0)) { console.error('拿不到收入密度（控制台没跑？）'); process.exit(2); }

const out = { at: new Date().toISOString(), density, price, source: sourceName, venues: {} };

// ---- vast：竞价 min_bid 中位 ----
try {
  const cfg = loadConfig();
  const vast = new Vast(cfg.vastApiKey);
  const offers = await vast.searchOffers({ ...cfg, useSpot: true, maxHourlySpend: 1.0, scanRows: 100 }, {}, undefined);
  const by = {};
  for (const o of offers) {
    const g = modelOf(o.gpu_name); if (!g) continue;
    const per = (Number(o.min_bid) || Number(o.dph_total) || 0) / (o.num_gpus || 1);
    if (per > 0) (by[g.key] ||= []).push(per);
  }
  out.venues.vast = { note: '竞价入场价 min_bid，按单卡折算', prices: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, { n: v.length, med: medianOrNull(v), min: Math.min(...v) }])) };
} catch (e) { out.venues.vast = { error: String(e.message).slice(0, 100) }; }

// ---- Clore：按天报价 ÷24 ----
try {
  const key = readEnv(`${SEC}/clore_key`).CLORE_KEY || fs.readFileSync(`${SEC}/clore_key`, 'utf8').trim();
  const r = await fetch('https://api.clore.ai/v1/marketplace', { headers: { auth: key } });
  const d = await r.json();
  const by = {};
  for (const s of d.servers || []) {
    if (s.rented) continue;
    const m = /^\s*(\d+)\s*x\s*(.+)$/.exec(s?.specs?.gpu || ''); if (!m) continue;
    const cnt = +m[1]; const g = modelOf(m[2]); if (!g) continue;
    const usd = Number(s?.price?.usd?.on_demand_usd); if (!(usd > 0)) continue;
    (by[g.key] ||= []).push(usd / cnt / 24);
  }
  out.venues.clore = { note: '按需 $/天 ÷24，未含 10% 平台费', prices: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, { n: v.length, med: medianOrNull(v), min: Math.min(...v) }])) };
} catch (e) { out.venues.clore = { error: String(e.message).slice(0, 100) }; }

// ---- RunPod：GraphQL gpuTypes ----
try {
  const key = fs.readFileSync(`${SEC}/runpod_key`, 'utf8').trim();
  const q = 'query { gpuTypes { displayName memoryInGb lowestPrice { minimumBidPrice uninterruptablePrice } } }';
  const r = await fetch('https://api.runpod.io/graphql', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ query: q }) });
  const d = await r.json();
  const by = { spot: {}, ondemand: {} };
  for (const gpu of d?.data?.gpuTypes || []) {
    const g = modelOf(gpu.displayName); if (!g) continue;
    const lp = gpu.lowestPrice || {};
    if (Number(lp.minimumBidPrice) > 0) (by.spot[g.key] ||= []).push(Number(lp.minimumBidPrice));
    if (Number(lp.uninterruptablePrice) > 0) (by.ondemand[g.key] ||= []).push(Number(lp.uninterruptablePrice));
  }
  const conv = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { n: v.length, med: medianOrNull(v), min: Math.min(...v) }]));
  out.venues.runpod = { note: '最低挂牌 spot/on-demand（多为 null）', spot: conv(by.spot), ondemand: conv(by.ondemand) };
} catch (e) { out.venues.runpod = { error: String(e.message).slice(0, 100) }; }

// ---- 汇总 ----
const models = (arg('models') || 'RTX3090,RTX4090,RTX4070S,RTX3080,RTX3070').split(',');
const rows = [];
for (const key of models) {
  const g = table.find(x => x.key === key.trim().toUpperCase()); if (!g) continue;
  const be = g.effective * density / 24;
  const v = out.venues.vast?.prices?.[g.key]?.med ?? null;
  const c = out.venues.clore?.prices?.[g.key]?.med ?? null;
  const rp = out.venues.runpod?.ondemand?.[g.key]?.med ?? null;
  const roi = p => (p ? ((be / p - 1) * 100) : null);
  rows.push({ model: g.name, th: g.effective, breakEven: +be.toFixed(4), vast: v, vastRoi: roi(v), clore: c, cloreRoi: roi(c), runpod: rp, runpodRoi: roi(rp) });
}
out.rows = rows;

if (has('json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

console.log(`\n收入密度 $${density.toFixed(5)}/TH·天（源 ${sourceName}）· PRL $${price}\n`);
console.log('型号             TH/s   盈亏线$ /h   vast竞价      Clore按需     RunPod按需');
for (const r of rows) {
  const f = (v, roi) => v == null ? '   —        ' : `${v.toFixed(4)} ${roi >= 0 ? '✅' : '  '}${(roi >= 0 ? '+' : '') + roi.toFixed(0)}%`.padEnd(14);
  console.log(`${r.model.padEnd(16)} ${String(r.th).padStart(4)}   ${r.breakEven.toFixed(4).padStart(8)}   ${f(r.vast, r.vastRoi)} ${f(r.clore, r.cloreRoi)} ${f(r.runpod, r.runpodRoi)}`);
}
console.log('\n提示：✅ 表示该场地中位价低于盈亏线（正收益），空白表示高于盈亏线。');
console.log('      n 是样本数；n=1 时中位就是那一台的报价，参考价值有限。');