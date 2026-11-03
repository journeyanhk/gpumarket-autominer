#!/usr/bin/env node
// 每日「矿工流向」观察（零成本、只读）：把 Pearl 与主要 GPU 币的 24 小时难度变化记一行。
//
// 为什么看难度而不是看币价：密度 ∝ 币价 ÷ 全网算力，而"算力"在其它 GPU 币的难度里先动。
// Pearl 自己的 24h 难度变化 ≈ 0 说明"流入已经停了"；转负则说明矿工开始撤离（密度会回升，
// 这是 PRL 恢复可租的唯一物理路径，见 PLAN §8）。
//
// 数据源：WhatToMine /coins.json（difficulty 为当前，difficulty24 为 24 小时前）。
// 用法：node tools/gpu-coin-scan.mjs [--json]
// 输出：追加到 /data/prl-automine/gpu-coin-daily.jsonl（一天一行，重复跑会多行）
import fs from 'node:fs';
import path from 'node:path';

const OUT = '/data/prl-automine/gpu-coin-daily.jsonl';
// 观察名单：Pearl 本体 + 各主流 GPU 算法各挑一个代表币（看"矿工从哪里来/往哪里去"）
const WATCH = [
  ['Pearl', 'Pearl 本体'],
  ['Ravencoin', 'KawPow 代表'],
  ['Neurai', 'KawPow'],
  ['Ergo', 'Autolykos'],
  ['IronFish', 'FishHash'],
  ['Karlsen', 'Karlsenhashv2'],
  ['Kaspa', 'kHeavyHash'],
];

const pct = (a, b) => { const x = Number(a), y = Number(b); return x > 0 && y > 0 ? +((x / y - 1) * 100).toFixed(2) : null; };

const out = { at: new Date().toISOString(), coins: {}, pearl: null, kryptex: null, signal: null, error: null };

// 领先指标（2026-11-03 用户要求）：Kryptex 池算力比 WTM 难度**早一个 retarget 周期**反映"矿工走没走"。
// 池算力（我们所在的那个矿池）先掉，然后才是全网难度掉、密度回升。
async function fetchKryptex() {
  for (const base of ['https://pool.kryptex.com/prl/api', 'https://prl-api.kryptex.network/api']) {
    try {
      const r = await fetch(base + '/v1/pool/info', { signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;
      const d = await r.json();
      const poolHs = Number(d.hashrate) || 0, netHs = Number(d.net_hashrate) || 0;
      if (!(poolHs > 0)) continue;
      return { poolHsEh: +(poolHs / 1e18).toFixed(3), netHsEh: +(netHs / 1e18).toFixed(1), sharePct: netHs > 0 ? +(poolHs / netHs * 100).toFixed(1) : null, workers: d.workers ?? null };
    } catch { /* 换下一个地址 */ }
  }
  return null;
}
// 前一天同一份 jsonl 的最后一条，用来算池算力的日变化
function prevKryptex() {
  try {
    const lines = fs.readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const o = JSON.parse(lines[i]);
      if (o.kryptex?.poolHsEh > 0 && Date.now() - Date.parse(o.at) > 6 * 3600e3) return o.kryptex;
    }
  } catch { /* 没有历史 */ }
  return null;
}

try {
  const r = await fetch('https://whattomine.com/coins.json', { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  const coins = d?.coins || {};
  for (const [name, note] of WATCH) {
    const c = coins[name];
    if (!c) { out.coins[name] = { note, missing: true }; continue; }
    const d24 = pct(c.difficulty, c.difficulty24);
    out.coins[name] = {
      note, algo: c.algorithm, difficulty: Math.round(Number(c.difficulty) || 0), difficulty24: Math.round(Number(c.difficulty24) || 0),
      change24hPct: d24,
      // 币价与收益也顺手记一下：难度掉但价格也掉，等于白掉
      price: Number(c.exchange_rate) || null, reward: Number(c.block_reward) || null,
    };
  }
  out.pearl = out.coins.Pearl?.change24hPct ?? null;
  out.kryptex = await fetchKryptex();
  const prevKx = prevKryptex();
  out.kryptexPrev = prevKx;
  out.kryptexChangePct = prevKx && out.kryptex ? +((out.kryptex.poolHsEh / prevKx.poolHsEh - 1) * 100).toFixed(2) : null;
  // 用户 2026-11-03：看**占比**而不是绝对值——池掉 5% 且全网也掉 5% 是市场整体撤退（好消息），
  // 池掉 5% 而全网平只是矿工换池（与我们无关）。两种情形处置完全不同。
  out.kryptexShareChangePct = prevKx && out.kryptex && prevKx.sharePct > 0 && out.kryptex.sharePct != null
    ? +((out.kryptex.sharePct / prevKx.sharePct - 1) * 100).toFixed(2) : null;
  out.netChangePct = prevKx && out.kryptex && prevKx.netHsEh > 0
    ? +((out.kryptex.netHsEh / prevKx.netHsEh - 1) * 100).toFixed(2) : null;
  // 信号：Pearl 难度停滞或回落 = 流入停/外流；其余 GPU 币难度下跌 = 矿工在离开别的币
  const gpu = Object.entries(out.coins).filter(([k, v]) => k !== 'Pearl' && v.change24hPct != null);
  const falling = gpu.filter(([, v]) => v.change24hPct < -3).map(([k]) => k);
  out.signal = {
    pearlFlat: out.pearl != null && Math.abs(out.pearl) < 1.5,
    pearlFalling: out.pearl != null && out.pearl < -1.5,
    gpuFalling: falling,
    // 领先信号：**池占比**日变化 ≤ -3%（比难度更早反映"矿工在离开我们这条链"）
    poolShareFalling: out.kryptexShareChangePct != null && out.kryptexShareChangePct <= -3,
    // 市场整体撤退：池算力与全网同时下降（对密度是好消息）
    marketRetreat: out.kryptexChangePct != null && out.netChangePct != null && out.kryptexChangePct <= -3 && out.netChangePct <= -3,
  };
} catch (e) { out.error = e.message.slice(0, 120); }

try { fs.appendFileSync(OUT, JSON.stringify(out) + '\n'); } catch { /* 写不进去不算失败 */ }

if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

console.log(`矿工流向 ${out.at}`);
if (out.error) { console.log(`⚠ ${out.error}`); process.exit(0); }
console.log('币种        算法            难度        24h 变化');
for (const [name, v] of Object.entries(out.coins)) {
  if (v.missing) { console.log(`${name.padEnd(11)} —（WTM 无此币）`); continue; }
  const chg = v.change24hPct == null ? '—' : `${v.change24hPct > 0 ? '+' : ''}${v.change24hPct}%`;
  console.log(`${name.padEnd(11)} ${String(v.algo).padEnd(14)} ${String(v.difficulty).padStart(12)}  ${chg}`);
}
if (out.kryptex) {
  const chg = out.kryptexChangePct == null ? '（无历史基线）' : `${out.kryptexChangePct > 0 ? '+' : ''}${out.kryptexChangePct}%`;
  const shChg = out.kryptexShareChangePct == null ? '—' : `${out.kryptexShareChangePct > 0 ? '+' : ''}${out.kryptexShareChangePct}%`;
  console.log(`Kryptex 池算力 ${out.kryptex.poolHsEh} EH/s（占全网 ${out.kryptex.sharePct}%，算力日变化 ${chg}，占比日变化 ${shChg}）`);
}
const s = out.signal || {};
if (s.marketRetreat) console.log(`→ 池算力 ${out.kryptexChangePct}% 且全网 ${out.netChangePct}%：市场整体撤退（对密度是好消息）`);
else if (s.poolShareFalling) console.log(`→ Kryptex 池占比日降 ${out.kryptexShareChangePct}%：矿工在离开这条链（领先信号）`);
if (s.pearlFalling) console.log('→ Pearl 难度回落：矿工开始撤离（对密度是正向信号）');
else if (s.pearlFlat) console.log('→ Pearl 难度停滞：流入已停（尚未外流）');
else if (out.pearl != null) console.log('→ Pearl 难度仍在涨：矿工还在往里挤');
if (s.gpuFalling?.length) console.log(`→ 同期在掉算力的 GPU 币：${s.gpuFalling.join('、')}`);