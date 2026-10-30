#!/usr/bin/env node
// Clore Spot 只读普查（B 线，零成本）：每小时把 Clore 的 Spot / 按需报价记一行，
// 和目标型号的 PRL 盈亏线、vast 竞价入场价对比，为 M3「第一个新市场」备数据。
//
// 为什么单独一个工具：venue-compare.mjs 是"随手比一次"，这里要的是**时间序列**——
// Clore 的清算价分布必须连跑几天才知道它是否长期低于 vast。
//
// 用法：node tools/clore-census.mjs [--json] [--models "2080 Ti,3080,4070S,3090"]
// 输出：追加到 /data/prl-automine/clore-census.jsonl（一行一次采样）
import fs from 'node:fs';
import path from 'node:path';

const SEC = '/data/prl-automine/.secrets';
const OUT = '/data/prl-automine/clore-census.jsonl';
const CTRL = 'http://127.0.0.1:8290/api/state';
const TARGETS = (() => {
  const i = process.argv.indexOf('--models');
  const s = i > 0 ? process.argv[i + 1] : '2080 Ti,3080,4070S,3090';
  return s.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
})();

const med = a => { const v = [...a].sort((x, y) => x - y); if (!v.length) return null; const m = Math.floor(v.length / 2); return +(v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2).toFixed(4); };

const readKey = () => {
  try {
    const raw = fs.readFileSync(path.join(SEC, 'clore_key'), 'utf8').trim();
    const m = /CLORE_KEY=(.+)/.exec(raw);
    return (m ? m[1] : raw).trim();
  } catch { return null; }
};

// 型号匹配：Clore 的 specs.gpu 形如 "1x RTX 3080" / "2x RTX 2080 Ti"
const modelKey = (s) => {
  const t = String(s || '').toLowerCase();
  if (/2080\s*ti/.test(t)) return '2080 Ti';
  if (/3080\s*ti/.test(t)) return '3080 Ti';
  if (/3080/.test(t)) return '3080';
  if (/4070\s*ti/.test(t)) return '4070 Ti';
  if (/4070\s*s|4070s/.test(t)) return '4070S';
  if (/3090/.test(t)) return '3090';
  if (/4060\s*ti/.test(t)) return '4060 Ti';
  return null;
};

const out = { at: new Date().toISOString(), models: {}, vastMinBid: {}, breakeven: null, error: null };

// 1) 本地口径：密度 + 每型号盈亏线（用控制台缓存，避免再算一遍）
try {
  const st = await (await fetch(CTRL)).json();
  const density = Number(st?.market?.usdPerThDay) || 0;   // $/TH·天（Kryptex 保守口径）
  out.density = +density.toFixed(5);
  const target = Number(st?.config?.targetProfitPct) || 20;
  // 每型号参考算力（TH/s）：从控制台报价里的 thRaw 反推最稳
  const refTh = {};
  for (const o of st?.offers || []) {
    const k = modelKey(o.gpuName);
    if (k && o.thRaw > 0) refTh[k] = +Number(o.thRaw).toFixed(1);
  }
  // vast 竞价入场价（min_bid，单卡）
  for (const o of st?.offers || []) {
    const k = modelKey(o.gpuName); if (!k) continue;
    const per = (Number(o.minBid) || Number(o.dph) || 0) / (o.numGpus || 1);
    if (per > 0) (out.vastMinBid[k] ||= []).push(per);
  }
  for (const k of Object.keys(out.vastMinBid)) out.vastMinBid[k] = med(out.vastMinBid[k]);
  // 盈亏线 = 算力 × 密度 ÷ 24 ÷ (1+目标ROI)
  out.breakeven = {};
  for (const [k, th] of Object.entries(refTh)) {
    out.breakeven[k] = +(th * density / 24 / (1 + target / 100)).toFixed(4);
  }
  out.refTh = refTh;
} catch (e) { out.error = `本地口径失败：${e.message.slice(0, 80)}`; }

// 2) Clore 报价
try {
  const key = readKey();
  if (!key) throw new Error('没有 clore_key');
  const r = await fetch('https://api.clore.ai/v1/marketplace', { headers: { auth: key } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  const spot = {}, ond = {};
  for (const s of d.servers || []) {
    const m = /^\s*(\d+)\s*x\s*(.+)$/.exec(s?.specs?.gpu || '');
    if (!m) continue;
    const cnt = +m[1];
    const k = modelKey(m[2]); if (!k || !TARGETS.includes(k.toLowerCase())) continue;
    if (s.rented) continue;
    const p = s?.price || {};
    // Spot 价在 price.spot['USD-Blockchain']（price.usd.spot 恒为 0，是个坑）
    const sp = Number(p?.spot?.['USD-Blockchain']);
    const od = Number(p?.usd?.on_demand_usd);
    if (sp > 0) (spot[k] ||= []).push(sp / cnt / 24);    // $/天 ÷24 → $/h（单卡）
    if (od > 0) (ond[k] ||= []).push(od / cnt / 24);
  }
  for (const k of new Set([...Object.keys(spot), ...Object.keys(ond)])) {
    const sP = med(spot[k] || []), oP = med(ond[k] || []);
    const be = out.breakeven?.[k] ?? null;
    out.models[k] = {
      nSpot: (spot[k] || []).length, spotMed: sP, spotMin: spot[k]?.length ? +Math.min(...spot[k]).toFixed(4) : null,
      nOnDemand: (ond[k] || []).length, onDemandMed: oP,
      breakeven: be,
      spotVsBreakeven: sP && be ? +(sP / be).toFixed(3) : null,   // <1 表示 Spot 比盈亏线便宜（有机会）
      spotVsVast: sP && out.vastMinBid?.[k] ? +(sP / out.vastMinBid[k]).toFixed(3) : null,
    };
  }
} catch (e) { out.error = (out.error ? out.error + '；' : '') + `Clore：${e.message.slice(0, 90)}`; }

// 3) 落盘一行
try { fs.appendFileSync(OUT, JSON.stringify(out) + '\n'); } catch { /* 写不进去不算失败 */ }

if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

console.log(`Clore Spot 普查 ${out.at}｜密度 $${out.density ?? '—'}/TH·天`);
if (out.error) console.log(`⚠ ${out.error}`);
const rows = Object.entries(out.models);
if (!rows.length) console.log('（本次没有目标型号的 Clore 报价）');
else {
  console.log('型号       Spot样本 Spot中位  Spot最低  按需中位  盈亏线   Spot/盈亏线  Spot/vast');
  for (const [k, v] of rows) {
    console.log(`${k.padEnd(10)} ${String(v.nSpot).padStart(6)}  ${String(v.spotMed ?? '—').padStart(8)}  ${String(v.spotMin ?? '—').padStart(8)}  ${String(v.onDemandMed ?? '—').padStart(8)}  ${String(v.breakeven ?? '—').padStart(6)}  ${String(v.spotVsBreakeven ?? '—').padStart(10)}  ${String(v.spotVsVast ?? '—').padStart(8)}`);
  }
  const win = rows.filter(([, v]) => v.spotVsBreakeven != null && v.spotVsBreakeven < 1);
  console.log(win.length ? `✅ 低于盈亏线：${win.map(([k]) => k).join('、')}` : '没有型号的 Spot 低于盈亏线');
}