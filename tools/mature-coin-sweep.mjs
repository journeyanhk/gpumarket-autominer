#!/usr/bin/env node
// 成熟币全灭表（2026-11-05）：回答"换币能不能救"。
//
// ⚠ 单位警告（这条比表本身重要）：
//   WhatToMine 的 `nethash` **不是所有算法都用 H/s**。实测：
//     Pearl  8.707e19 → 87.1 EH/s（与我们自己口径一致，H/s ✓）
//     RVN    4.954e11 → 若 H/s 则 0.5 TH/s（公开量级 4–5 TH/s）→ 单位存疑
//     Ergo   5.959e11 → 若 H/s 则 0.6 TH/s（公开量级 15–25 TH/s）→ 单位存疑
//   所以"零系数、直接算密度"只对 **Pearl 这类 nethash 单位可验证的币** 成立。
//   本工具的做法：
//     ① 先算每 TH·天密度；② 用 3080 的算法算力反推 $/h；
//     ③ 若结果落在 [1e-4, 1] $/h 之外 → 标记 unitSuspect，**不参与跨算法排序**；
//     ④ 跨算法比较只在 `--units <algo>=<factor>` 显式给出时才做（不许默认拟合）。
//
// 用法：
//   node tools/mature-coin-sweep.mjs                 # 按算法分组，组内排序
//   node tools/mature-coin-sweep.mjs --units kawpow=0.001   # 显式给单位系数后才跨算法比
import fs from 'node:fs';

const WTM = 'https://whattomine.com/coins.json';
const GATE_BTC = 'https://api.gateio.ws/api/v4/spot/tickers?currency_pair=BTC_USDT';
const CLORE_MIN = 0.0499;      // Clore 3080 最低可租（mrl 6h）
const ROI_REQ = 1.467;         // 与 isRentable 同源：收入 ≥ 成本 × 1.467

// 3080 在各算法上的算力（**每卡算力表**，不是单位系数）。
// 2026-11-05 用户纠正：WTM 的 nethash 跨算法就是 H/s（三个独立锚点 ≤3%），
// 真正不确定的是这张表本身（±30%），而不是单位（1.0）。
import { CARD_HASHRATE_TH as TH3080, HASHRATE_NOTE } from '../src/m3/hashrate.js';
// 每卡算力表见 src/m3/hashrate.js（±30% 量级；单位系数由锚点断言）

// 锚点表：算法有锚点 → 单位可信；无锚点 → 该算法的币只能是 watch（不许 pass）
const anchors = JSON.parse(fs.readFileSync(new URL('./unit-anchors.json', import.meta.url), 'utf8')).anchors;
// Pearl 的交付算力与口径从引擎拿（pooled 45 TH vs spec 68.9 会让差距从 1.9× 变成 1.2×）
let pearlTh = null, pearlSrc = null;
try {
  const st = await (await fetch('http://127.0.0.1:8290/api/state', { signal: AbortSignal.timeout(8000) })).json();
  // 必须取 **3080** 那一行：这张表算的是 3080 的 $/h，取 2080 Ti 会把 Pearl 高估 1.9 倍
  const row = (st?.pricingTable || []).find(r => /3080(?!\s*Ti)/i.test(r.model));
  pearlTh = Number(row?.th) || null; pearlSrc = row?.thSource || null;
} catch { /* 引擎不可达就用 null，表里标 thSource=null */ }
TH3080.pearl = pearlTh;

const unitsArg = process.argv.find(a => a.startsWith('--units'));
const units = {};
if (unitsArg) for (const kv of (process.argv[process.argv.indexOf('--units') + 1] || '').split(',')) {
  const [k, v] = kv.split('='); if (k && v) units[k.toLowerCase()] = Number(v);
}

const btc = Number((await (await fetch(GATE_BTC, { signal: AbortSignal.timeout(15000) })).json())?.[0]?.last) || 0;
const coins = (await (await fetch(WTM, { signal: AbortSignal.timeout(30000) })).json())?.coins || {};

const rows = [];
for (const [name, v] of Object.entries(coins)) {
  const nh = Number(v.nethash), bt = Number(v.block_time), br = Number(v.block_reward), px = Number(v.exchange_rate);
  if (!(nh > 0 && bt > 0 && br > 0 && px > 0 && btc > 0)) continue;
  // Nicehash-* 是聚合市场价，不是币（nethash 是它自己的口径），排除
  if (/^nicehash/i.test(name)) continue;
  const algo = String(v.algorithm || '').toLowerCase();
  const usdPerThDay = (br * (3600 / bt) * px * btc) / nh * 1e12 * 24;
  const th = TH3080[algo];
  const factor = units[algo] ?? 1;
  const revHr = th ? usdPerThDay * th / 24 * factor : null;
  // 单位可信度来自**锚点**，不来自"数值是否离谱"（我的 $0.0101 能通过范围过滤却仍可能错 10 倍）
  const anchor = anchors[algo];
  const anchored = anchor?.status === 'ok';
  const unitSuspect = !anchored;
  rows.push({
    coin: name, tag: v.tag, algo, nethash: nh, usdPerThDay: +usdPerThDay.toFixed(5),
    th3080: th ?? null, thSource: algo === 'pearl' ? pearlSrc : 'table', revHr: revHr == null ? null : +revHr.toFixed(4),
    anchored, unitSuspect,
    ceiling: revHr == null ? null : +(revHr / ROI_REQ).toFixed(4),
    gap: revHr == null ? null : +(CLORE_MIN / (revHr / ROI_REQ)).toFixed(1),
  });
}

// 单位可验证 = 不可疑且有 3080 算力
const usable = rows.filter(r => r.revHr != null && !r.unitSuspect);
usable.sort((a, b) => b.revHr - a.revHr);

if (process.argv.includes('--json')) { console.log(JSON.stringify({ at: new Date().toISOString(), btc, cloreMin: CLORE_MIN, roiReq: ROI_REQ, rows }, null, 2)); process.exit(0); }

console.log(`成熟币全灭表 ${new Date().toISOString()}｜BTC $${btc}｜基准租价 $${CLORE_MIN}/h（Clore 3080 最低）｜门槛 ×${ROI_REQ}`);
console.log(`币 ${rows.length} 个；单位可验证且有 3080 算力的 ${usable.length} 个\n`);
console.log('coin            algo          密度$/TH·天   3080 $/h   达标上限   溢价    thSource   锚点');
for (const r of usable.slice(0, 12)) {
  console.log(`${String(r.coin).padEnd(15)} ${String(r.algo).padEnd(12)} ${String(r.usdPerThDay).padStart(10)} ${String(r.revHr).padStart(9)} ${String(r.ceiling).padStart(10)} ${String(r.gap + '×').padStart(7)} ${String(r.thSource).padStart(9)}   ${r.anchored ? 'ok' : '—'}`);
}
const suspect = rows.filter(r => r.unitSuspect);
if (suspect.length) {
  console.log(`\n· 无锚点算法（单位未独立验证，只能 watch）：${[...new Set(suspect.map(r => r.algo))].join('、')}`);
  console.log('  → 补锚点：node tools/unit-anchor-check.mjs；锚点未过 [0.8,1.25] 的算法立即停用 pass。');
}
const best = usable[0];
if (best) {
  const pass = usable.filter(r => r.gap <= 1);
  console.log(`\n结论：pass=${pass.length}；最优 ${best.coin}（${best.algo}）$${best.revHr}/h，仍差 ${best.gap}×`);
  console.log(pass.length ? `✅ 有币过线：${pass.map(r => r.coin).join('、')}` : '⛔ 无币过线——换币种这条路在本租价下关闭');
}
try { fs.appendFileSync('/data/prl-automine/mature-coin-sweep.jsonl', JSON.stringify({ at: new Date().toISOString(), btc, usable: usable.slice(0, 12), suspect: suspect.map(r => r.coin) }) + '\n'); } catch { /* 写不进去不影响输出 */ }